import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const PORT = Number(process.env.OPENCODE_PROXY_PORT ?? process.env.PROXY_PORT ?? 4567);
const UPSTREAM =
	process.env.OPENCODE_PROXY_UPSTREAM ?? process.env.UPSTREAM ?? "https://api.openai.com";
const LOG_FILE = resolve(
	process.env.OPENCODE_PROXY_LOG ?? process.env.LOG_FILE ?? "./logs/opencode-api.jsonl",
);

let sequence = 0;

await mkdir(dirname(LOG_FILE), { recursive: true });

async function writeLog(event: Record<string, unknown>): Promise<void> {
	await appendFile(LOG_FILE, `${JSON.stringify(event)}\n`, "utf8");
}

function redactHeaders(headers: Headers): Record<string, string> {
	const safe: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		const lower = key.toLowerCase();
		if (
			lower === "authorization" ||
			lower === "cookie" ||
			lower === "set-cookie" ||
			lower.includes("api-key") ||
			lower.includes("token")
		) {
			safe[key] = "[REDACTED]";
		} else {
			safe[key] = value;
		}
	}
	return safe;
}

function safeResponseHeaders(headers: Headers): Headers {
	const output = new Headers(headers);
	output.delete("content-length");
	output.delete("content-encoding");
	output.delete("transfer-encoding");
	output.delete("connection");
	return output;
}

function parseBody(bytes: Uint8Array | null): unknown {
	if (!bytes?.byteLength) return null;
	const text = new TextDecoder().decode(bytes);
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function previewContent(value: unknown, max = 120): string {
	if (typeof value === "string") return value.replace(/\s+/g, " ").slice(0, max);
	if (value === undefined || value === null) return "";
	try {
		return JSON.stringify(value).replace(/\s+/g, " ").slice(0, max);
	} catch {
		return String(value).slice(0, max);
	}
}

function printRequestSummary(id: number, method: string, url: URL, body: unknown): void {
	console.log(`\n[proxy:${id}] -> ${method} ${url.pathname}${url.search}`);
	if (!body || typeof body !== "object" || Array.isArray(body)) return;

	const record = body as Record<string, unknown>;
	if (record.model) console.log(`  model: ${String(record.model)}`);
	if (record.stream !== undefined) console.log(`  stream: ${String(record.stream)}`);
	if (record.tool_choice !== undefined) {
		console.log(`  tool_choice: ${previewContent(record.tool_choice, 200)}`);
	}
	if (record.reasoning_effort !== undefined) {
		console.log(`  reasoning_effort: ${String(record.reasoning_effort)}`);
	}

	if (typeof record.instructions === "string") {
		console.log(`  instructions: ${previewContent(record.instructions)}`);
	}

	if (Array.isArray(record.messages)) {
		console.log(`  messages: ${record.messages.length}`);
		for (const [index, item] of record.messages.entries()) {
			if (!item || typeof item !== "object") continue;
			const message = item as Record<string, unknown>;
			const toolCalls = Array.isArray(message.tool_calls)
				? ` tool_calls=${message.tool_calls.length}`
				: "";
			const reasoning = typeof message.reasoning_content === "string" ? " reasoning=yes" : "";
			console.log(
				`    ${index}: ${String(message.role ?? "?")}${toolCalls}${reasoning} ${previewContent(message.content)}`,
			);
		}
	}

	if (Array.isArray(record.input)) {
		console.log(`  input items: ${record.input.length}`);
		for (const [index, item] of record.input.entries()) {
			if (!item || typeof item !== "object") continue;
			const input = item as Record<string, unknown>;
			console.log(
				`    ${index}: ${String(input.role ?? input.type ?? "?")} ${previewContent(input.content)}`,
			);
		}
	}

	if (Array.isArray(record.tools)) {
		console.log(`  tools: ${record.tools.length}`);
		for (const tool of record.tools) {
			if (!tool || typeof tool !== "object") continue;
			const entry = tool as Record<string, unknown>;
			const fn = entry.function;
			const functionName =
				fn && typeof fn === "object" ? (fn as Record<string, unknown>).name : undefined;
			console.log(`    - ${String(functionName ?? entry.name ?? entry.type ?? "unknown")}`);
		}
	}
}

type ToolTrace = {
	index: number;
	id?: string;
	type?: string;
	name: string;
	arguments: string;
};

type ResponseTrace = {
	protocol: "chat.completions" | "responses" | "unknown";
	responseId?: string;
	model?: string;
	content: string;
	reasoning: string;
	toolCalls: Map<number, ToolTrace>;
	finishReasons: string[];
	usage?: unknown;
	eventTypes: Map<string, number>;
};

function createResponseTrace(): ResponseTrace {
	return {
		protocol: "unknown",
		content: "",
		reasoning: "",
		toolCalls: new Map(),
		finishReasons: [],
		eventTypes: new Map(),
	};
}

function incrementEvent(trace: ResponseTrace, type: string): void {
	trace.eventTypes.set(type, (trace.eventTypes.get(type) ?? 0) + 1);
}

function getToolTrace(trace: ResponseTrace, index: number): ToolTrace {
	let tool = trace.toolCalls.get(index);
	if (!tool) {
		tool = { index, name: "", arguments: "" };
		trace.toolCalls.set(index, tool);
	}
	return tool;
}

function appendUnique(target: string[], value: unknown): void {
	if (typeof value === "string" && value && !target.includes(value)) target.push(value);
}

function processChatCompletionEvent(trace: ResponseTrace, data: Record<string, unknown>): void {
	trace.protocol = "chat.completions";
	if (typeof data.id === "string") trace.responseId = data.id;
	if (typeof data.model === "string") trace.model = data.model;
	if (data.usage) trace.usage = data.usage;

	const choices = Array.isArray(data.choices) ? data.choices : [];
	for (const choiceValue of choices) {
		if (!choiceValue || typeof choiceValue !== "object") continue;
		const choice = choiceValue as Record<string, unknown>;
		appendUnique(trace.finishReasons, choice.finish_reason);
		const delta = choice.delta;
		if (!delta || typeof delta !== "object") continue;
		const d = delta as Record<string, unknown>;
		if (typeof d.content === "string") trace.content += d.content;
		if (typeof d.reasoning_content === "string") trace.reasoning += d.reasoning_content;

		if (Array.isArray(d.tool_calls)) {
			for (const callValue of d.tool_calls) {
				if (!callValue || typeof callValue !== "object") continue;
				const call = callValue as Record<string, unknown>;
				const index = typeof call.index === "number" ? call.index : 0;
				const tool = getToolTrace(trace, index);
				if (typeof call.id === "string") tool.id = call.id;
				if (typeof call.type === "string") tool.type = call.type;
				const fn = call.function;
				if (fn && typeof fn === "object") {
					const f = fn as Record<string, unknown>;
					if (typeof f.name === "string") tool.name += f.name;
					if (typeof f.arguments === "string") tool.arguments += f.arguments;
				}
			}
		}
	}
}

function findResponseToolIndex(trace: ResponseTrace, id: unknown): number {
	if (typeof id === "string") {
		for (const [index, tool] of trace.toolCalls) {
			if (tool.id === id) return index;
		}
	}
	return trace.toolCalls.size;
}

function processResponsesEvent(
	trace: ResponseTrace,
	eventType: string,
	data: Record<string, unknown>,
): void {
	trace.protocol = "responses";
	incrementEvent(trace, eventType);

	const response = data.response;
	if (response && typeof response === "object") {
		const r = response as Record<string, unknown>;
		if (typeof r.id === "string") trace.responseId = r.id;
		if (typeof r.model === "string") trace.model = r.model;
		if (r.usage) trace.usage = r.usage;
	}

	if (eventType === "response.output_text.delta" && typeof data.delta === "string") {
		trace.content += data.delta;
	}
	if (
		(eventType === "response.reasoning_text.delta" ||
			eventType === "response.reasoning_summary_text.delta") &&
		typeof data.delta === "string"
	) {
		trace.reasoning += data.delta;
	}

	if (eventType === "response.output_item.added" || eventType === "response.output_item.done") {
		const item = data.item;
		if (item && typeof item === "object") {
			const value = item as Record<string, unknown>;
			if (value.type === "function_call") {
				const index =
					typeof data.output_index === "number" ? data.output_index : trace.toolCalls.size;
				const tool = getToolTrace(trace, index);
				if (typeof value.call_id === "string") tool.id = value.call_id;
				else if (typeof value.id === "string") tool.id = value.id;
				tool.type = "function";
				if (typeof value.name === "string") tool.name = value.name;
				if (typeof value.arguments === "string") tool.arguments = value.arguments;
			}
		}
	}

	if (eventType === "response.function_call_arguments.delta" && typeof data.delta === "string") {
		const index = findResponseToolIndex(trace, data.item_id ?? data.call_id);
		const tool = getToolTrace(trace, index);
		if (typeof data.call_id === "string") tool.id = data.call_id;
		tool.arguments += data.delta;
	}

	if (eventType === "response.function_call_arguments.done") {
		const index = findResponseToolIndex(trace, data.item_id ?? data.call_id);
		const tool = getToolTrace(trace, index);
		if (typeof data.call_id === "string") tool.id = data.call_id;
		if (typeof data.arguments === "string") tool.arguments = data.arguments;
	}

	if (eventType === "response.completed") appendUnique(trace.finishReasons, "completed");
	if (eventType === "response.failed") appendUnique(trace.finishReasons, "failed");
	if (eventType === "response.incomplete") appendUnique(trace.finishReasons, "incomplete");
}

function processSseBlock(trace: ResponseTrace, block: string): void {
	let eventType = "";
	const dataLines: string[] = [];
	for (const rawLine of block.split(/\r?\n/)) {
		if (rawLine.startsWith("event:")) eventType = rawLine.slice(6).trim();
		if (rawLine.startsWith("data:")) dataLines.push(rawLine.slice(5).trimStart());
	}
	if (!dataLines.length) return;
	const rawData = dataLines.join("\n");
	if (rawData === "[DONE]") {
		incrementEvent(trace, "[DONE]");
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawData);
	} catch {
		return;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
	const data = parsed as Record<string, unknown>;
	if (eventType || (typeof data.type === "string" && data.type.startsWith("response."))) {
		processResponsesEvent(trace, eventType || String(data.type), data);
	} else if (data.object === "chat.completion.chunk" || Array.isArray(data.choices)) {
		processChatCompletionEvent(trace, data);
	}
}

function processSseText(trace: ResponseTrace, state: { buffer: string }, text: string): void {
	state.buffer += text;
	while (true) {
		const match = /\r?\n\r?\n/.exec(state.buffer);
		if (!match || match.index === undefined) break;
		const block = state.buffer.slice(0, match.index);
		state.buffer = state.buffer.slice(match.index + match[0].length);
		if (block.trim()) processSseBlock(trace, block);
	}
}

function traceSummary(trace: ResponseTrace): Record<string, unknown> {
	return {
		protocol: trace.protocol,
		response_id: trace.responseId ?? null,
		model: trace.model ?? null,
		content: trace.content,
		reasoning_content: trace.reasoning,
		tool_calls: [...trace.toolCalls.values()].sort((a, b) => a.index - b.index),
		finish_reasons: trace.finishReasons,
		usage: trace.usage ?? null,
		event_types: Object.fromEntries(trace.eventTypes),
	};
}

function printResponseTrace(id: number, trace: ResponseTrace): void {
	console.log(`[proxy:${id}] trace protocol=${trace.protocol}`);
	if (trace.reasoning) console.log(`  reasoning: ${previewContent(trace.reasoning, 240)}`);
	if (trace.content) console.log(`  content: ${previewContent(trace.content, 240)}`);
	for (const tool of [...trace.toolCalls.values()].sort((a, b) => a.index - b.index)) {
		console.log(
			`  tool[${tool.index}]: ${tool.name || "?"} id=${tool.id ?? "?"} args=${previewContent(tool.arguments, 300)}`,
		);
	}
	if (trace.finishReasons.length) console.log(`  finish: ${trace.finishReasons.join(", ")}`);
	if (trace.usage) console.log(`  usage: ${previewContent(trace.usage, 300)}`);
}

const server = Bun.serve({
	port: PORT,
	async fetch(request) {
		const id = ++sequence;
		const startedAt = performance.now();
		const incomingUrl = new URL(request.url);
		const upstreamUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, UPSTREAM);
		const hasBody = request.method !== "GET" && request.method !== "HEAD";
		const requestBytes = hasBody ? new Uint8Array(await request.arrayBuffer()) : null;
		const requestBody = parseBody(requestBytes);

		await writeLog({
			type: "request",
			id,
			time: new Date().toISOString(),
			method: request.method,
			path: incomingUrl.pathname,
			query: incomingUrl.search,
			headers: redactHeaders(request.headers),
			body: requestBody,
			body_bytes: requestBytes?.byteLength ?? 0,
		});
		printRequestSummary(id, request.method, incomingUrl, requestBody);

		const upstreamHeaders = new Headers(request.headers);
		upstreamHeaders.delete("host");
		upstreamHeaders.delete("content-length");
		upstreamHeaders.delete("accept-encoding");

		let upstreamResponse: Response;
		try {
			upstreamResponse = await fetch(upstreamUrl, {
				method: request.method,
				headers: upstreamHeaders,
				body: requestBytes?.byteLength ? requestBytes : undefined,
				redirect: "manual",
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await writeLog({
				type: "proxy_error",
				id,
				time: new Date().toISOString(),
				error: message,
				elapsed_ms: Math.round(performance.now() - startedAt),
			});
			console.error(`[proxy:${id}] upstream error: ${message}`);
			return Response.json(
				{ error: { message: `Inspection proxy upstream error: ${message}` } },
				{ status: 502 },
			);
		}

		const responseHeaders = safeResponseHeaders(upstreamResponse.headers);
		const contentType = upstreamResponse.headers.get("content-type") ?? "";
		console.log(`[proxy:${id}] <- HTTP ${upstreamResponse.status} ${contentType || "unknown"}`);

		await writeLog({
			type: "response_start",
			id,
			time: new Date().toISOString(),
			status: upstreamResponse.status,
			headers: redactHeaders(upstreamResponse.headers),
			elapsed_ms: Math.round(performance.now() - startedAt),
		});

		if (contentType.includes("text/event-stream") && upstreamResponse.body) {
			const reader = upstreamResponse.body.getReader();
			const decoder = new TextDecoder();
			const sseState = { buffer: "" };
			const trace = createResponseTrace();
			let firstByteLogged = false;
			let chunkIndex = 0;
			let totalBytes = 0;

			const stream = new ReadableStream<Uint8Array>({
				async pull(controller) {
					const { done, value } = await reader.read();
					if (done) {
						const tail = decoder.decode();
						if (tail) processSseText(trace, sseState, tail);
						if (sseState.buffer.trim()) processSseBlock(trace, sseState.buffer);
						await writeLog({
							type: "response_summary",
							id,
							time: new Date().toISOString(),
							...traceSummary(trace),
							chunks: chunkIndex,
							body_bytes: totalBytes,
							elapsed_ms: Math.round(performance.now() - startedAt),
						});
						printResponseTrace(id, trace);
						await writeLog({
							type: "response_end",
							id,
							time: new Date().toISOString(),
							chunks: chunkIndex,
							body_bytes: totalBytes,
							elapsed_ms: Math.round(performance.now() - startedAt),
						});
						controller.close();
						return;
					}

					chunkIndex += 1;
					totalBytes += value.byteLength;
					if (!firstByteLogged) {
						firstByteLogged = true;
						await writeLog({
							type: "first_byte",
							id,
							time: new Date().toISOString(),
							elapsed_ms: Math.round(performance.now() - startedAt),
						});
					}

					const decoded = decoder.decode(value, { stream: true });
					processSseText(trace, sseState, decoded);
					await writeLog({
						type: "stream_chunk",
						id,
						index: chunkIndex,
						time: new Date().toISOString(),
						data: decoded,
						body_bytes: value.byteLength,
					});
					controller.enqueue(value);
				},
				async cancel(reason) {
					await writeLog({
						type: "response_cancelled",
						id,
						time: new Date().toISOString(),
						reason: previewContent(reason, 300),
						elapsed_ms: Math.round(performance.now() - startedAt),
					});
					await reader.cancel(reason);
				},
			});

			return new Response(stream, {
				status: upstreamResponse.status,
				headers: responseHeaders,
			});
		}

		const responseBytes = new Uint8Array(await upstreamResponse.arrayBuffer());
		const parsedResponse = parseBody(responseBytes);
		await writeLog({
			type: "response",
			id,
			time: new Date().toISOString(),
			status: upstreamResponse.status,
			body: parsedResponse,
			body_bytes: responseBytes.byteLength,
			elapsed_ms: Math.round(performance.now() - startedAt),
		});

		return new Response(responseBytes, {
			status: upstreamResponse.status,
			headers: responseHeaders,
		});
	},
});

console.log(`OpenCode inspection proxy listening on http://127.0.0.1:${server.port}`);
console.log(`Upstream: ${UPSTREAM}`);
console.log(`JSONL log: ${LOG_FILE}`);
console.log("Raw SSE chunks plus structured response_summary events are recorded.");
console.log("Secrets in auth/cookie/token headers are redacted from logs.");
