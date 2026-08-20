import { fairUseGovernor, type FairUsePolicy } from "../agent/governor.ts";
import { agentRuntime, type AgentMode, type AgentRuntimeConfig } from "../agent/runtime.ts";
import { evictProviderClient } from "../providers/registry.ts";
import type { WebProviderClient } from "../providers/types.ts";
import { ProviderApiError, SessionExpiredError } from "../providers/types.ts";
import { buildPromptFromMessages, parseToolResponse } from "../tool-calling/converter.ts";
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

export function setRouteTimeoutSec(sec: number): void {
	_routeTimeoutMs = sec * 1000;
}

export function configureAgentLayer(runtimeConfig: AgentRuntimeConfig, fairUsePolicy: FairUsePolicy): void {
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

export async function handleChatCompletions(
	inputBody: ChatCompletionRequest,
	client: WebProviderClient,
): Promise<Response> {
	if (!inputBody.messages || inputBody.messages.length === 0) {
		return jsonError("messages is required and must not be empty", 400);
	}
	if (!inputBody.model) {
		return jsonError("model is required", 400);
	}

	const optimized = agentRuntime.optimize(inputBody);
	if (optimized.rejection) {
		return withAgentHeaders(
			jsonError(optimized.rejection.message, optimized.rejection.status),
			optimized.sessionId,
			optimized.snapshot.savedPromptChars,
		);
	}

	const body = optimized.body;
	const id = generateId();
	const model = body.model;
	const { prompt, hasTools } = buildPromptFromMessages(
		body.messages,
		body.tools,
		body.tool_choice,
		_agentMode === "optimized",
	);
	if (!prompt) return jsonError("Could not construct prompt from messages", 400);

	const release =
		_agentMode === "optimized"
			? await fairUseGovernor.acquire(client.providerId, _fairUsePolicy)
			: () => {};
	const handler = body.stream
		? handleStreaming(id, model, prompt, hasTools, body, client, optimized.sessionId, release)
		: handleNonStreaming(id, model, prompt, hasTools, body, client, optimized.sessionId, release);

	const timeout = new Promise<Response>((resolve) =>
		setTimeout(() => {
			console.error(`[chat-completions] Request timed out after ${_routeTimeoutMs / 1000}s`);
			resolve(jsonError("Gateway timeout: upstream provider did not respond in time", 504));
		}, _routeTimeoutMs),
	);

	const response = await Promise.race([handler, timeout]);
	return withAgentHeaders(response, optimized.sessionId, optimized.snapshot.savedPromptChars);
}

async function handleNonStreaming(
	id: string,
	model: string,
	prompt: string,
	hasTools: boolean,
	body: ChatCompletionRequest,
	client: WebProviderClient,
	sessionId: string,
	release: () => void,
): Promise<Response> {
	try {
		const stream = await client.sendMessage({ message: prompt, model, sessionId });
		const result = await client.parseStream(stream);
		const { content, toolCalls, finishReason } = hasTools
			? parseToolResponse(result.text, body.tools)
			: { content: result.text, toolCalls: undefined, finishReason: "stop" as const };
		const promptTokens = estimateTokens(prompt);
		const completionTokens = estimateTokens(result.text);
		const response: ChatCompletionResponse = {
			id,
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model,
			system_fingerprint: `fp_${id.slice(-12)}`,
			choices: [
				{
					index: 0,
					message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
					finish_reason: finishReason,
				},
			],
			usage: {
				prompt_tokens: promptTokens,
				completion_tokens: completionTokens,
				total_tokens: promptTokens + completionTokens,
			},
		};
		return Response.json(response);
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
	sessionId: string,
	release: () => void,
): Promise<Response> {
	let providerStream: ReadableStream<Uint8Array>;
	try {
		providerStream = await client.sendMessage({ message: prompt, model, sessionId });
	} catch (err) {
		release();
		return providerErrorResponse(err, "streaming (pre-stream)");
	}

	const readable = new ReadableStream({
		async start(controller) {
			const w = createSseWriter(controller);
			try {
				w.writeChunk(id, model, [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]);
				if (!hasTools) await streamWithoutTools(w, id, model, providerStream, client);
				else await streamWithTools(w, id, model, providerStream, body, client);
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

async function streamWithTools(
	w: SseWriter,
	id: string,
	model: string,
	providerStream: ReadableStream<Uint8Array>,
	body: ChatCompletionRequest,
	client: WebProviderClient,
) {
	const result = await client.parseStream(providerStream);
	const { content, toolCalls, finishReason } = parseToolResponse(result.text, body.tools);
	if (finishReason === "tool_calls" && toolCalls) {
		emitToolCallDeltas(w, id, model, toolCalls);
		w.writeChunk(id, model, [{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
	} else {
		if (content) w.writeChunk(id, model, [{ index: 0, delta: { content }, finish_reason: null }]);
		w.writeChunk(id, model, [{ index: 0, delta: {}, finish_reason: "stop" }]);
	}
}

function withAgentHeaders(response: Response, sessionId: string, savedChars: number): Response {
	const headers = new Headers(response.headers);
	headers.set("x-webtoapi-session-id", sessionId);
	headers.set("x-webtoapi-saved-context-chars", String(savedChars));
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
	if (err instanceof SessionExpiredError) {
		evictProviderClient(err.providerId);
		console.error(
			`[chat-completions] ${context}: session expired for "${err.providerId}". Run 'token-free-gateway webauth'.`,
		);
		return jsonError(err.message, 401);
	}
	if (err instanceof ProviderApiError) {
		console.error(`[chat-completions] ${context}: provider error ${err.httpStatus}: ${err.message}`);
		return jsonError(err.message, err.httpStatus);
	}
	const message = err instanceof Error ? err.message : String(err);
	console.error(`[chat-completions] ${context}: ${message}`);
	return jsonError(message, 502);
}
