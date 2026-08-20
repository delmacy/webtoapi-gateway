import type { Page, Request, Response } from "playwright-core";
import { runtimeProfiles, type RuntimeTransport } from "../providers/runtime-profile.ts";

export interface NetworkObserverOptions {
	providerId: string;
	matches: (request: Request) => boolean;
	transport?: RuntimeTransport;
}

const observedPages = new WeakMap<Page, Set<string>>();

function safeOrigin(url: string): string | undefined {
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

function safeRequestMetadata(request: Request): { requestKeys?: string[]; model?: string } {
	try {
		const body = request.postDataJSON();
		if (!body || typeof body !== "object" || Array.isArray(body)) return {};
		const record = body as Record<string, unknown>;
		const model = typeof record.model === "string" && record.model.trim() ? record.model.trim() : undefined;
		return {
			requestKeys: Object.keys(record).slice(0, 32),
			model,
		};
	} catch {
		return {};
	}
}

function observeRequest(providerId: string, request: Request, transport?: RuntimeTransport): void {
	const url = request.url();
	const headers = request.headers();
	const clientVersion = headers.version?.trim();
	const metadata = safeRequestMetadata(request);
	runtimeProfiles.update(providerId, {
		origin: safeOrigin(url),
		endpoint: url,
		transport: transport ?? "unknown",
		requestMethod: request.method(),
		clientVersion: clientVersion || undefined,
		requestKeys: metadata.requestKeys,
		model: metadata.model,
		source: "network",
	});
}

function observeResponse(providerId: string, response: Response, transport?: RuntimeTransport): void {
	const url = response.url();
	const contentType = response.headers()["content-type"]?.toLowerCase() ?? "";
	let inferred = transport ?? "unknown";
	if (contentType.includes("text/event-stream")) inferred = "sse";
	else if (contentType.includes("connect+json")) inferred = "connect-rpc";
	else if (contentType.includes("application/json")) inferred = "json";

	runtimeProfiles.update(providerId, {
		origin: safeOrigin(url),
		endpoint: url,
		transport: inferred,
		source: "network",
	});
}

/**
 * Observe normal traffic from an already authenticated provider tab.
 * Records endpoint/protocol and a small allowlist of non-sensitive request
 * metadata. It never stores cookies, Authorization values, request content,
 * CAPTCHA data, or browser fingerprints.
 */
export function installNetworkObserver(page: Page, options: NetworkObserverOptions): void {
	let providers = observedPages.get(page);
	if (!providers) {
		providers = new Set<string>();
		observedPages.set(page, providers);
	}
	if (providers.has(options.providerId)) return;
	providers.add(options.providerId);

	page.on("request", (request) => {
		if (options.matches(request)) observeRequest(options.providerId, request, options.transport);
	});

	page.on("response", (response) => {
		const request = response.request();
		if (options.matches(request)) observeResponse(options.providerId, response, options.transport);
	});
}
