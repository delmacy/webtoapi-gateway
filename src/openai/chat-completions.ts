import { type FairUsePolicy, fairUseGovernor } from "../agent/governor.ts";
import { type AgentMode, type AgentRuntimeConfig, agentRuntime } from "../agent/runtime.ts";
import { GatewayProtocolError } from "../protocol/types.ts";
import { evictProviderClient } from "../providers/registry.ts";
import type { ProviderSendParams, WebProviderClient } from "../providers/types.ts";
import { ProviderApiError, SessionExpiredError } from "../providers/types.ts";
import { buildProviderPromptPlan, type ProviderPromptPlan } from "../session/provider-prompt.ts";
import {
	agentResponseCache,
	type CachedAgentResponse,
	fingerprintChatRequest,
} from "../session/response-cache.ts";
import { parseToolResponse } from "../tool-calling/converter.ts";
import { makeChunk, sseDone, sseEvent, sseHeaders } from "./sse.ts";
import type {
	ChatCompletionRequest,
	ChatCompletionResponse,
	ToolCallDelta,
	ToolCallOutput,
} from "./types.ts";

let _routeTimeoutMs = 300_000;
let _fairUsePolicy: FairUsePolicy = { maxConcurrency: 1, minIntervalMs: 2500 };
let _agentMode: AgentMode = "optimized";

export interface ChatCompletionHandlerOptions {
	sessionIdOverride?: string;
}

type ParsedToolResponse = {
	content: string | null;
	toolCalls: ToolCallOutput[] | undefined;
	finishReason: "stop" | "tool_calls";
};

type ExecutionContext = {
	sessionId: string;
	sessionEpoch: number;
	providerId: string;
	requestFingerprint: string;
	plan: ProviderPromptPlan;
	cacheEnabled: boolean;
	signal?: AbortSignal;
};

type AgentHeaderContext = {
	sessionId: string;
	savedChars: number;
	sessionSource?: string;
	historyRelation?: string;
	historyEpoch?: number;
	promptMode?: string;
	stateful?: boolean;
	cache?: "hit" | "miss" | "disabled";
};

export function setRouteTimeoutSec(sec: number): void {
	_routeTimeoutMs = sec * 1000;
}

export function configureAgentLayer(
	runtimeConfig: AgentRuntimeConfig,
	fairUsePolicy: FairUsePolicy,
): void {
	agentRuntime.configure(runtimeConfig);
	_agentMode = runtimeConfig.mode;
	_fairUsePolicy = {
		maxConcurrency: Math.max(1, Math.floor(fairUsePolicy.maxConcurrency)),
		minIntervalMs: Math.max(0, Math.floor(fairUsePolicy.minIntervalMs)),
	};
}

function generateId(): string {
	return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function buildCompletionResponse(
	id: string,
	model: string,
	parsed: ParsedToolResponse,
	prompt: string,
	rawText: string,
): ChatCompletionResponse {
	const promptTokens = estimateTokens(prompt);
	const completionTokens = estimateTokens(rawText);
	return {
		id,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model,
		system_fingerprint: `fp_${id.slice(-12)}`,
		choices: [
			{
				index: 0,
				message: {
					role: "assistant",
					content: parsed.content,
					...(parsed.toolCalls ? { tool_calls: parsed.toolCalls } : {}),
				},
				finish_reason: parsed.finishReason,
			},
		],
		usage: {
			prompt_tokens: promptTokens,
			completion_tokens: completionTokens,
			total_tokens: promptTokens + completionTokens,
		},
	};
}

function providerSendParams(
	model: string,
	prompt: string,
	execution: ExecutionContext,
): ProviderSendParams {
	return {
		message: prompt,
		model,
		signal: execution.signal,
		statefulSession: execution.plan.statefulSession,
		sessionId: execution.plan.statefulSession ? execution.sessionId : undefined,
		sessionEpoch: execution.plan.statefulSession ? execution.sessionEpoch : undefined,
		resetSession: execution.plan.resetSession,
		rehydrationMessage: execution.plan.fullPrompt,
	};
}

function cachedParsed(response: CachedAgentResponse): ParsedToolResponse {
	return {
		content: response.content,
		toolCalls: response.toolCalls,
		finishReason: response.finishReason,
	};
}

export async function handleChatCompletions(
	inputBody: ChatCompletionRequest,
	client: WebProviderClient,
	options: ChatCompletionHandlerOptions = {},
): Promise<Response> {
	if (!inputBody.messages || inputBody.messages.length === 0) {
		return jsonError("messages is required and must not be empty", 400);
	}
	if (!inputBody.model) {
		return jsonError("model is required", 400);
	}

	const optimized = agentRuntime.optimize(inputBody, options.sessionIdOverride);
	const baseHeaders: AgentHeaderContext = {
		sessionId: optimized.sessionId,
		savedChars: optimized.snapshot.savedPromptChars,
		sessionSource: optimized.sessionIdSource,
		historyRelation: optimized.reconciliation.relation,
		historyEpoch: optimized.reconciliation.epoch,
	};
	if (optimized.rejection) {
		return withAgentHeaders(
			jsonError(optimized.rejection.message, optimized.rejection.status),
			baseHeaders,
		);
	}

	const body = optimized.body;
	const id = generateId();
	const model = body.model;
	const capabilities = client.sessionCapabilities;
	const statefulEligible =
		_agentMode === "optimized" &&
		optimized.sessionStable &&
		capabilities?.persistentConversation === true &&
		capabilities.deltaPrompts === true &&
		capabilities.resettable === true;
	const plan = buildProviderPromptPlan(body, optimized.reconciliation, {
		compactTools: _agentMode === "optimized",
		statefulEligible,
	});
	if (!plan.prompt) return jsonError("Could not construct prompt from messages", 400);

	const requestFingerprint = fingerprintChatRequest(inputBody);
	const cacheEnabled = statefulEligible && plan.hasTools;
	const execution: ExecutionContext = {
		sessionId: optimized.sessionId,
		sessionEpoch: optimized.reconciliation.epoch,
		providerId: client.providerId,
		requestFingerprint,
		plan,
		cacheEnabled,
	};
	const headers: AgentHeaderContext = {
		...baseHeaders,
		promptMode: plan.mode,
		stateful: plan.statefulSession,
		cache: cacheEnabled ? "miss" : "disabled",
	};

	if (cacheEnabled && optimized.reconciliation.relation === "exact") {
		const cached = agentResponseCache.get(
			client.providerId,
			optimized.sessionId,
			requestFingerprint,
		);
		if (cached) {
			const response = body.stream
				? streamingResponseFromParsed(id, model, cachedParsed(cached))
				: Response.json(
						buildCompletionResponse(
							id,
							model,
							cachedParsed(cached),
							cached.promptText,
							cached.rawText,
						),
					);
			return withAgentHeaders(response, { ...headers, cache: "hit" });
		}
	}

	const release =
		_agentMode === "optimized"
			? await fairUseGovernor.acquire(client.providerId, _fairUsePolicy)
			: () => {};
	const routeAbort = new AbortController();
	execution.signal = routeAbort.signal;
	const handler = body.stream
		? handleStreaming(id, model, plan.prompt, plan.hasTools, body, client, execution, release)
		: handleNonStreaming(id, model, plan.prompt, plan.hasTools, body, client, execution, release);

	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<Response>((resolve) => {
		timeoutId = setTimeout(() => {
			const message = `Gateway timeout: upstream provider did not respond in time`;
			console.error(`[chat-completions] Request timed out after ${_routeTimeoutMs / 1000}s`);
			routeAbort.abort(new Error(message));
			resolve(jsonError(message, 504));
		}, _routeTimeoutMs);
	});

	const response = await Promise.race([handler, timeout]);
	if (timeoutId) clearTimeout(timeoutId);
	return withAgentHeaders(response, headers);
}

async function handleNonStreaming(
	id: string,
	model: string,
	prompt: string,
	hasTools: boolean,
	body: ChatCompletionRequest,
	client: WebProviderClient,
	execution: ExecutionContext,
	release: () => void,
): Promise<Response> {
	try {
		const stream = await client.sendMessage(providerSendParams(model, prompt, execution));
		const result = await client.parseStream(stream);
		const parsed = hasTools
			? parseToolResponse(result.text, body.tools, _agentMode === "optimized")
			: { content: result.text, toolCalls: undefined, finishReason: "stop" as const };
		if (execution.cacheEnabled) {
			agentResponseCache.set(
				execution.providerId,
				execution.sessionId,
				execution.requestFingerprint,
				{
					...parsed,
					rawText: result.text,
					promptText: prompt,
				},
			);
		}
		return Response.json(buildCompletionResponse(id, model, parsed, prompt, result.text));
	} catch (err) {
		return providerErrorResponse(err, "non-streaming");
	} finally {
		release();
	}
}

type SseWriter = {
	writeChunk(id: string, model: string, choices: Parameters<typeof makeChunk>[2]): void;
	done(): void;
	error(message: string): void;
	close(): void;
};

function createSseWriter(controller: ReadableStreamDefaultController<Uint8Array>): SseWriter {
	const encoder = new TextEncoder();
	const emit = (data: string) => controller.enqueue(encoder.encode(data));
	return {
		writeChunk(id, model, choices) {
			emit(sseEvent(JSON.stringify(makeChunk(id, model, choices))));
		},
		done() {
			emit(sseDone());
		},
		error(message: string) {
			emit(sseEvent(JSON.stringify({ error: { message, type: "server_error" } })));
		},
		close() {
			controller.close();
		},
	};
}

function emitToolCallDeltas(w: SseWriter, id: string, model: string, toolCalls: ToolCallOutput[]) {
	for (let i = 0; i < toolCalls.length; i++) {
		const tc = toolCalls[i];
		if (!tc) continue;
		const tcStart: ToolCallDelta = {
			index: i,
			id: tc.id,
			type: "function",
			function: { name: tc.function.name, arguments: "" },
		};
		w.writeChunk(id, model, [{ index: 0, delta: { tool_calls: [tcStart] }, finish_reason: null }]);
		const tcArgs: ToolCallDelta = { index: i, function: { arguments: tc.function.arguments } };
		w.writeChunk(id, model, [{ index: 0, delta: { tool_calls: [tcArgs] }, finish_reason: null }]);
	}
}

async function handleStreaming(
	id: string,
	model: string,
	prompt: string,
	hasTools: boolean,
	body: ChatCompletionRequest,
	client: WebProviderClient,
	execution: ExecutionContext,
	release: () => void,
): Promise<Response> {
	let providerStream: ReadableStream<Uint8Array>;
	try {
		providerStream = await client.sendMessage(providerSendParams(model, prompt, execution));
	} catch (err) {
		release();
		return providerErrorResponse(err, "streaming (pre-stream)");
	}

	let bufferedToolResponse: ParsedToolResponse | undefined;
	if (hasTools) {
		try {
			const result = await client.parseStream(providerStream);
			bufferedToolResponse = parseToolResponse(result.text, body.tools, _agentMode === "optimized");
			if (execution.cacheEnabled) {
				agentResponseCache.set(
					execution.providerId,
					execution.sessionId,
					execution.requestFingerprint,
					{
						...bufferedToolResponse,
						rawText: result.text,
						promptText: prompt,
					},
				);
			}
		} catch (err) {
			release();
			return providerErrorResponse(err, "streaming (tool protocol)");
		}
	}

	const readable = new ReadableStream({
		async start(controller) {
			const w = createSseWriter(controller);
			try {
				w.writeChunk(id, model, [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]);
				if (!hasTools) await streamWithoutTools(w, id, model, providerStream, client);
				else if (bufferedToolResponse) emitBufferedToolResponse(w, id, model, bufferedToolResponse);
				w.done();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error(`[chat-completions] Stream error (mid-stream): ${message}`);
				w.error(message);
				w.done();
			} finally {
				release();
				w.close();
			}
		},
	});
	return new Response(readable, { headers: sseHeaders() });
}

function streamingResponseFromParsed(
	id: string,
	model: string,
	parsed: ParsedToolResponse,
): Response {
	const readable = new ReadableStream({
		start(controller) {
			const w = createSseWriter(controller);
			w.writeChunk(id, model, [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]);
			emitBufferedToolResponse(w, id, model, parsed);
			w.done();
			w.close();
		},
	});
	return new Response(readable, { headers: sseHeaders() });
}

async function streamWithoutTools(
	w: SseWriter,
	id: string,
	model: string,
	providerStream: ReadableStream<Uint8Array>,
	client: WebProviderClient,
) {
	await client.parseStream(providerStream, (delta) => {
		w.writeChunk(id, model, [{ index: 0, delta: { content: delta }, finish_reason: null }]);
	});
	w.writeChunk(id, model, [{ index: 0, delta: {}, finish_reason: "stop" }]);
}

function emitBufferedToolResponse(
	w: SseWriter,
	id: string,
	model: string,
	response: ParsedToolResponse,
): void {
	if (response.finishReason === "tool_calls" && response.toolCalls) {
		emitToolCallDeltas(w, id, model, response.toolCalls);
		w.writeChunk(id, model, [{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
		return;
	}
	if (response.content) {
		w.writeChunk(id, model, [
			{ index: 0, delta: { content: response.content }, finish_reason: null },
		]);
	}
	w.writeChunk(id, model, [{ index: 0, delta: {}, finish_reason: "stop" }]);
}

function withAgentHeaders(response: Response, context: AgentHeaderContext): Response {
	const headers = new Headers(response.headers);
	headers.set("x-webtoapi-session-id", context.sessionId);
	headers.set("x-webtoapi-saved-context-chars", String(context.savedChars));
	if (context.sessionSource) headers.set("x-webtoapi-session-source", context.sessionSource);
	if (context.historyRelation) headers.set("x-webtoapi-history-relation", context.historyRelation);
	if (context.historyEpoch !== undefined) {
		headers.set("x-webtoapi-history-epoch", String(context.historyEpoch));
	}
	if (context.promptMode) headers.set("x-webtoapi-prompt-mode", context.promptMode);
	if (context.stateful !== undefined) headers.set("x-webtoapi-stateful", String(context.stateful));
	if (context.cache) headers.set("x-webtoapi-response-cache", context.cache);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function jsonError(message: string, status: number): Response {
	return Response.json({ error: { message, type: "invalid_request_error" } }, { status });
}

function providerErrorResponse(err: unknown, context: string): Response {
	if (err instanceof GatewayProtocolError) {
		console.error(`[chat-completions] ${context}: protocol ${err.code}: ${err.message}`);
		return Response.json(
			{
				error: {
					message: err.message,
					type: "gateway_protocol_error",
					code: err.code,
					...(err.details === undefined ? {} : { details: err.details }),
				},
			},
			{ status: 502 },
		);
	}
	if (err instanceof SessionExpiredError) {
		evictProviderClient(err.providerId);
		console.error(
			`[chat-completions] ${context}: session expired for "${err.providerId}". Run 'token-free-gateway webauth'.`,
		);
		return jsonError(err.message, 401);
	}
	if (err instanceof ProviderApiError) {
		console.error(
			`[chat-completions] ${context}: provider error ${err.httpStatus}: ${err.message}`,
		);
		return jsonError(err.message, err.httpStatus);
	}
	const message = err instanceof Error ? err.message : String(err);
	console.error(`[chat-completions] ${context}: ${message}`);
	return jsonError(message, 502);
}
