import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const PORT = Number(process.env.OPENCODE_PROXY_PORT ?? process.env.PROXY_PORT ?? 4567);
const UPSTREAM = process.env.OPENCODE_PROXY_UPSTREAM ?? process.env.UPSTREAM ?? "https://api.openai.com";
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

	if (typeof record.instructions === "string") {
		console.log(`  instructions: ${previewContent(record.instructions)}`);
	}

	if (Array.isArray(record.messages)) {
		console.log(`  messages: ${record.messages.length}`);
		for (const [index, item] of record.messages.entries()) {
			if (!item || typeof item !== "object") continue;
			const message = item as Record<string, unknown>;
			console.log(
				`    ${index}: ${String(message.role ?? "?")} ${previewContent(message.content)}`,
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
			return Response.json({ error: { message: `Inspection proxy upstream error: ${message}` } }, { status: 502 });
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
			let firstByteLogged = false;
			let chunkIndex = 0;
			let totalBytes = 0;

			const stream = new ReadableStream<Uint8Array>({
				async pull(controller) {
					const { done, value } = await reader.read();
					if (done) {
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

					await writeLog({
						type: "stream_chunk",
						id,
						index: chunkIndex,
						time: new Date().toISOString(),
						data: new TextDecoder().decode(value),
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
		await writeLog({
			type: "response",
			id,
			time: new Date().toISOString(),
			status: upstreamResponse.status,
			body: parseBody(responseBytes),
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
console.log("Secrets in auth/cookie/token headers are redacted from logs.");
