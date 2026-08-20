import { agentRuntime } from "./agent/runtime.ts";
import { authenticate } from "./auth.ts";
import { BrowserManager } from "./browser/manager.ts";
import { loadConfig } from "./config.ts";
import {
	configureAgentLayer,
	handleChatCompletions,
	setRouteTimeoutSec,
} from "./openai/chat-completions.ts";
import { listAuthorizedProviders } from "./providers/auth-store.ts";
import {
	checkAllSessions,
	getClientForModel,
	listAllModels,
	resolveModelToProvider,
} from "./providers/registry.ts";
import { runtimeProfiles } from "./providers/runtime-profile.ts";

const config = loadConfig();
setRouteTimeoutSec(config.requestTimeoutSec);
configureAgentLayer(
	{
		mode: config.agentMode,
		sessionIdleTtlSec: config.agentSessionIdleTtlSec,
		maxToolTurns: config.agentMaxToolTurns,
		maxIdenticalToolCalls: config.agentMaxIdenticalToolCalls,
		toolResultMaxChars: config.agentToolResultMaxChars,
		preserveTailMessages: config.agentPreserveTailMessages,
		telemetry: config.agentTelemetry,
	},
	{
		maxConcurrency: config.agentMaxConcurrencyPerProvider,
		minIntervalMs: config.agentMinIntervalMs,
	},
);

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers":
		"Content-Type, Authorization, X-WebToAPI-Session-Id, X-OpenCode-Session",
};

function withCors(res: Response): Response {
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => {
		headers[k] = v;
	});
	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers: { ...headers, ...CORS_HEADERS },
	});
}

async function handleRequest(req: Request): Promise<Response> {
	const { pathname } = new URL(req.url);

	if (req.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: CORS_HEADERS });
	}

	if (pathname === "/health" || pathname === "/healthz") {
		return withCors(await handleHealthRoute());
	}

	const authError = authenticate(req, config.gatewayApiKey);
	if (authError) return withCors(authError);

	if (pathname === "/v1/chat/completions" && req.method === "POST") {
		return withCors(await handleChatCompletionsRoute(req));
	}

	if (pathname === "/v1/models" && req.method === "GET") {
		return withCors(await handleModelsRoute());
	}

	if (pathname.startsWith("/v1/models/") && req.method === "GET") {
		const modelId = decodeURIComponent(pathname.slice("/v1/models/".length));
		return withCors(await handleModelByIdRoute(modelId));
	}

	return withCors(
		Response.json(
			{
				error: {
					message: `Unknown endpoint: ${req.method} ${pathname}`,
					type: "invalid_request_error",
				},
			},
			{ status: 404 },
		),
	);
}

async function handleHealthRoute(): Promise<Response> {
	const authorized = listAuthorizedProviders();
	const browserHealthy = await BrowserManager.getInstance().isHealthy();
	const sessions = await checkAllSessions();
	const hasExpired = Object.values(sessions).some((s) => !s.valid && s.reason !== "unchecked");
	const overallStatus = !browserHealthy ? "degraded" : hasExpired ? "session_expired" : "ok";
	const agentSessions = agentRuntime.listSnapshots();
	return Response.json({
		status: overallStatus,
		browser: browserHealthy ? "connected" : "disconnected",
		providers: authorized.length,
		models: (await listAllModels()).length,
		sessions,
		runtimeDiscovery: runtimeProfiles.all(),
		agent: {
			mode: config.agentMode,
			activeSessions: agentSessions.length,
			stableSessions: agentSessions.filter((session) => session.sessionStable).length,
			maxConcurrencyPerProvider: config.agentMaxConcurrencyPerProvider,
			minIntervalMs: config.agentMinIntervalMs,
			maxToolTurns: config.agentMaxToolTurns,
		},
	});
}

function logOpenCodeHeaders(req: Request): void {
	const interesting = [
		"x-opencode-session",
		"x-opencode-request",
		"x-opencode-project",
		"x-opencode-client",
		"x-webtoapi-session-id",
		"user-agent",
	];
	const values = interesting
		.map((name) => {
			const value = req.headers.get(name)?.trim();
			return value ? `${name}=${value}` : undefined;
		})
		.filter((value): value is string => Boolean(value));
	console.log(`[request-headers] ${values.length > 0 ? values.join(" ") : "no-opencode-session-headers"}`);
}

async function handleChatCompletionsRoute(req: Request): Promise<Response> {
	logOpenCodeHeaders(req);

	let body: any;
	try {
		body = await req.json();
	} catch {
		return Response.json(
			{ error: { message: "Invalid JSON body", type: "invalid_request_error" } },
			{ status: 400 },
		);
	}

	const provider = await getClientForModel(body.model || "");
	if (!provider) {
		return Response.json(
			{
				error: {
					message: `No authorized provider found for model "${body.model || ""}". Run 'token-free-gateway webauth' to authorize providers.`,
					type: "invalid_request_error",
				},
			},
			{ status: 404 },
		);
	}

	const sessionIdOverride =
		req.headers.get("x-webtoapi-session-id")?.trim() ||
		req.headers.get("x-opencode-session")?.trim() ||
		undefined;
	return handleChatCompletions(body, provider, { sessionIdOverride });
}

async function handleModelsRoute(): Promise<Response> {
	const models = await listAllModels();
	const now = Math.floor(Date.now() / 1000);
	const data = await Promise.all(
		models.map(async (m) => ({
			id: m.id,
			object: "model" as const,
			created: now,
			owned_by: (await resolveModelToProvider(m.id)) ?? "web-provider",
		})),
	);
	return Response.json({ object: "list", data });
}

async function handleModelByIdRoute(modelId: string): Promise<Response> {
	const models = await listAllModels();
	const model = models.find((m) => m.id === modelId);
	if (!model) {
		return Response.json(
			{ error: { message: `Model '${modelId}' not found`, type: "invalid_request_error" } },
			{ status: 404 },
		);
	}
	return Response.json({
		id: model.id,
		object: "model",
		created: Math.floor(Date.now() / 1000),
		owned_by: (await resolveModelToProvider(model.id)) ?? "web-provider",
	});
}

const server = Bun.serve({
	port: config.port,
	fetch: handleRequest,
	idleTimeout: 0,
});

const authorized = listAuthorizedProviders();
console.log(`Token-Free Gateway listening on http://localhost:${server.port}`);
console.log(`Auth: ${config.gatewayApiKey ? "enabled (Bearer token)" : "disabled"}`);
console.log(`Request timeout: ${config.requestTimeoutSec}s`);
console.log(
	`Agent mode: ${config.agentMode}; provider concurrency=${config.agentMaxConcurrencyPerProvider}; min interval=${config.agentMinIntervalMs}ms`,
);
console.log(
	`Authorized providers: ${authorized.length > 0 ? authorized.join(", ") : "none — run 'token-free-gateway webauth' to authorize"}`,
);

// Eagerly connect to the authenticated Chrome session so provider network
// observers are installed before the user sends manual messages in the tabs.
// Previously BrowserManager was lazy and /health only performed a lightweight
// CDP probe, so runtime discovery never started until a provider API call.
try {
	await BrowserManager.getInstance().getContext();
} catch (err) {
	console.warn(
		`[BrowserManager] Runtime discovery startup failed: ${err instanceof Error ? err.message : String(err)}`,
	);
}

async function gracefulShutdown(signal: string) {
	console.log(`\nReceived ${signal}, shutting down...`);
	await BrowserManager.getInstance().shutdown();
	server.stop(true);
	process.exit(0);
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

export { server };
