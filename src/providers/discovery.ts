import type { Page } from "playwright-core";
import { installNetworkObserver } from "../browser/network-observer.ts";

interface DiscoveryRule {
	providerId: string;
	pageMatches: (url: string) => boolean;
	requestMatches: (url: string) => boolean;
	transport?: "json" | "sse" | "connect-rpc" | "dom" | "unknown";
}

const RULES: DiscoveryRule[] = [
	{
		providerId: "claude-web",
		pageMatches: (url) => url.includes("claude.ai"),
		requestMatches: (url) => url.includes("claude.ai/api/") && /completion|chat_conversations/.test(url),
		transport: "sse",
	},
	{
		providerId: "qwen-web",
		pageMatches: (url) => /qwen|chat\.qwen\.ai/i.test(url),
		requestMatches: (url) => /qwen|chat\.qwen\.ai/i.test(url) && /chat|conversation|message/i.test(url),
		transport: "sse",
	},
	{
		providerId: "kimi-web",
		pageMatches: (url) => /kimi\.(ai|com)/i.test(url),
		requestMatches: (url) => /kimi\.gateway\.chat\.v1\.ChatService\/Chat/i.test(url),
		transport: "connect-rpc",
	},
];

/** Attach metadata-only discovery observers to a provider page. */
export function installProviderDiscovery(page: Page): void {
	const pageUrl = page.url();
	for (const rule of RULES) {
		if (!rule.pageMatches(pageUrl)) continue;
		installNetworkObserver(page, {
			providerId: rule.providerId,
			matches: rule.requestMatches,
			transport: rule.transport,
		});
	}
}

/** Re-check rules after navigation because a blank/new tab may become a provider tab later. */
export function watchProviderNavigation(page: Page): void {
	installProviderDiscovery(page);
	page.on("domcontentloaded", () => installProviderDiscovery(page));
}
