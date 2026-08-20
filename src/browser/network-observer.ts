import type { Page, Request, Response } from "playwright-core";
import { runtimeProfiles, type RuntimeTransport } from "../providers/runtime-profile.ts";

export interface NetworkObserverOptions {
	providerId: string;
	matches: (url: string) => boolean;
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

function observeRequest(providerId: string, request: Request, transport?: RuntimeTransport): void {
	const url = request.url();
	runtimeProfiles.update(providerId, {
		origin: safeOrigin(url),
		endpoint: url,
		transport: transport ?? "unknown",
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
 * This intentionally records only endpoint/protocol metadata; it does not log
 * cookies, Authorization values, request bodies, CAPTCHA data, or fingerprints.
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
		if (options.matches(request.url())) observeRequest(options.providerId, request, options.transport);
	});

	page.on("response", (response) => {
		if (options.matches(response.url())) observeResponse(options.providerId, response, options.transport);
	});
}
