import type { Page, Request } from "playwright-core";
import { installNetworkObserver } from "../browser/network-observer.ts";

interface DiscoveryRule {
	providerId: string;
	pageMatches: (url: string) => boolean;
	requestMatches: (request: Request) => boolean;
	transport?: "json" | "sse" | "connect-rpc" | "dom" | "unknown";
}

const RULES: DiscoveryRule[] = [
	{
		providerId: "claude-web",
		pageMatches: (url) => url.includes("claude.ai"),
		requestMatches: (request) => {
			const url = request.url();
			return (
				request.method() === "POST" &&
				url.includes("claude.ai/api/") &&
				/completion|chat_conversations/.test(url)
			);
		},
		transport: "sse",
	},
	{
		providerId: "qwen-web",
		pageMatches: (url) => /chat\.qwen\.ai/i.test(url),
		requestMatches: (request) => {
			const url = request.url();
			return (
				request.method() === "POST" &&
				/chat\.qwen\.ai/i.test(url) &&
				/api\/v\d+\/(chats\/new|chat\/completions|chat\/.*completion)/i.test(url)
			);
		},
		transport: "sse",
	},
	{
		providerId: "kimi-web",
		pageMatches: (url) => /kimi\.(ai|com)/i.test(url),
		requestMatches: (request) =>
			request.method() === "POST" &&
			/kimi\.gateway\.chat\.v1\.ChatService\/Chat/i.test(request.url()),
		transport: "connect-rpc",
	},
];

const watchedPages = new WeakSet<Page>();

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
	if (watchedPages.has(page)) return;
	watchedPages.add(page);
	installProviderDiscovery(page);
	page.on("domcontentloaded", () => installProviderDiscovery(page));
}
