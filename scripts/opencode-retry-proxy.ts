import { appendFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

const FRONT_PORT = Number(process.env.OPENCODE_PROXY_PORT ?? 4567);
const INSPECTOR_PORT = Number(process.env.OPENCODE_PROXY_INSPECTOR_PORT ?? 4568);
const UPSTREAM = process.env.OPENCODE_PROXY_UPSTREAM ?? "https://opencode.ai";
const FAULT_REQUEST = Number(process.env.OPENCODE_PROXY_FAULT_REQUEST ?? 2);
const FAULT_MODE = String(process.env.OPENCODE_PROXY_FAULT_MODE ?? "429").toLowerCase();
const FAULT_DELAY_MS = Number(process.env.OPENCODE_PROXY_FAULT_DELAY_MS ?? 12000);
const FAULT_LOG = resolve(process.env.OPENCODE_PROXY_FAULT_LOG ?? "./logs/opencode-retry.jsonl");
const INSPECTOR_LOG = resolve(process.env.OPENCODE_PROXY_LOG ?? "./logs/opencode-api.jsonl");

await mkdir(dirname(FAULT_LOG), { recursive: true });

async function log(event: Record<string, unknown>): Promise<void> {
	await appendFile(FAULT_LOG, `${JSON.stringify(event)}\n`, "utf8");
}

function hashBody(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function errorBody(status: number, message: string): Response {
	return Response.json(
		{
			error: {
				message,
				type: status === 429 ? "rate_limit_error" : "api_error",
				code: status === 429 ? "rate_limit_exceeded" : "internal_error",
			},
		},
		{
			status,
			headers: status === 429 ? { "retry-after": "1" } : undefined,
		},
	);
}

const inspector = Bun.spawn([process.execPath, "scripts/opencode-proxy.ts"], {
	stdout: "inherit",
	stderr: "inherit",
	env: {
		...process.env,
		OPENCODE_PROXY_PORT: String(INSPECTOR_PORT),
		OPENCODE_PROXY_UPSTREAM: UPSTREAM,
		OPENCODE_PROXY_LOG: INSPECTOR_LOG,
	},
});

let sequence = 0;
let injected = false;

const server = Bun.serve({
	port: FRONT_PORT,
	async fetch(request) {
		const id = ++sequence;
		const url = new URL(request.url);
		const hasBody = request.method !== "GET" && request.method !== "HEAD";
		const bytes = hasBody ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array();
		const bodyHash = hashBody(bytes);
		const shouldInject = !injected && id === FAULT_REQUEST;

		await log({
			type: "request",
			id,
			time: new Date().toISOString(),
			method: request.method,
			path: url.pathname,
			query: url.search,
			body_bytes: bytes.byteLength,
			body_sha256: bodyHash,
			fault_target: shouldInject,
		});

		console.log(
			`[retry-proxy:${id}] ${request.method} ${url.pathname}${url.search} bytes=${bytes.byteLength} sha256=${bodyHash.slice(0, 12)}`,
		);

		if (shouldInject) {
			injected = true;
			await log({
				type: "fault_injected",
				id,
				time: new Date().toISOString(),
				mode: FAULT_MODE,
				delay_ms: FAULT_MODE === "timeout" ? FAULT_DELAY_MS : 0,
				body_sha256: bodyHash,
			});

			console.log(`[retry-proxy:${id}] injecting ${FAULT_MODE}`);
			if (FAULT_MODE === "timeout") {
				await Bun.sleep(FAULT_DELAY_MS);
				return errorBody(504, `Injected timeout after ${FAULT_DELAY_MS}ms`);
			}
			if (FAULT_MODE === "500") return errorBody(500, "Injected HTTP 500 for retry inspection");
			return errorBody(429, "Injected HTTP 429 for retry inspection");
		}

		const inspectorUrl = new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${INSPECTOR_PORT}`);
		const headers = new Headers(request.headers);
		headers.delete("host");
		headers.delete("content-length");

		const response = await fetch(inspectorUrl, {
			method: request.method,
			headers,
			body: bytes.byteLength ? bytes : undefined,
			redirect: "manual",
		});

		await log({
			type: "forwarded_response",
			id,
			time: new Date().toISOString(),
			status: response.status,
			body_sha256: bodyHash,
		});

		return response;
	},
});

async function shutdown(): Promise<void> {
	server.stop(true);
	inspector.kill();
	await inspector.exited.catch(() => {});
}

process.on("SIGINT", () => {
	void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
	void shutdown().finally(() => process.exit(0));
});

console.log(`OpenCode retry inspection proxy: http://127.0.0.1:${server.port}`);
console.log(`Inspector backend: http://127.0.0.1:${INSPECTOR_PORT}`);
console.log(`Upstream: ${UPSTREAM}`);
console.log(`Fault: request #${FAULT_REQUEST} mode=${FAULT_MODE}`);
if (FAULT_MODE === "timeout") console.log(`Timeout delay: ${FAULT_DELAY_MS}ms`);
console.log(`Retry log: ${FAULT_LOG}`);
console.log(`Inspector log: ${INSPECTOR_LOG}`);
