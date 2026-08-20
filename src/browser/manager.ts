/**
 * Centralized browser lifecycle manager for all web AI providers.
 * Maintains a single shared CDP connection to Chrome, with auto-reconnection,
 * health checking, and optional Chrome auto-start.
 */

import type { Browser, BrowserContext, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { watchProviderNavigation } from "../providers/discovery.ts";
import { getChromeWebSocketUrl, getDefaultCdpUrl, getHeadersWithAuth } from "./cdp-helpers.ts";

export interface BrowserCookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	secure?: boolean;
}

export type PlaywrightCookie = {
	name: string;
	value: string;
	domain?: string;
	path?: string;
	url?: string;
	secure?: boolean;
};

/**
 * Convert cookie-header shaped entries to Playwright/CDP-safe cookie objects.
 * `__Host-` cookies must be host-only, Secure, and rooted at `/`; using `url`
 * rather than `domain` preserves that invariant. `__Secure-` cookies must be Secure.
 */
export function normalizeBrowserCookie(cookie: BrowserCookie): PlaywrightCookie {
	const host = cookie.domain.replace(/^\./, "");
	if (cookie.name.startsWith("__Host-")) {
		return {
			name: cookie.name,
			value: cookie.value,
			url: `https://${host}/`,
			secure: true,
		};
	}
	return {
		name: cookie.name,
		value: cookie.value,
		domain: cookie.domain,
		path: cookie.path,
		secure: cookie.secure === true || cookie.name.startsWith("__Secure-"),
	};
}

class BrowserManager {
	private static instance: BrowserManager | null = null;

	private browser: Browser | null = null;
	private context: BrowserContext | null = null;
	private connecting: Promise<BrowserContext> | null = null;
	private disconnected = false;

	static getInstance(): BrowserManager {
		if (!BrowserManager.instance) {
			BrowserManager.instance = new BrowserManager();
		}
		return BrowserManager.instance;
	}

	async getContext(): Promise<BrowserContext> {
		if (this.context && !this.disconnected) return this.context;
		if (this.connecting) return this.connecting;

		this.connecting = this.connect();
		try {
			return await this.connecting;
		} finally {
			this.connecting = null;
		}
	}

	async getPage(domain: string, fallbackUrl?: string): Promise<Page> {
		const ctx = await this.getContext();
		const pages = ctx.pages();
		const existing = pages.find((p) => p.url().includes(domain));
		if (existing) {
			watchProviderNavigation(existing);
			return existing;
		}

		return this.createPage(fallbackUrl);
	}

	/**
	 * Create a fresh page instead of reusing an existing provider tab.
	 * Stateful DOM fallbacks use this to keep one logical session per tab.
	 */
	async createPage(fallbackUrl?: string): Promise<Page> {
		const ctx = await this.getContext();
		const page = await ctx.newPage();
		if (fallbackUrl) {
			await page.goto(fallbackUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
		}
		return page;
	}

	async addCookies(cookies: BrowserCookie[]): Promise<void> {
		if (cookies.length === 0) return;
		const ctx = await this.getContext();
		const normalized = cookies.map(normalizeBrowserCookie);
		const urls = [
			...new Set(
				cookies
					.map((cookie) => cookie.domain.replace(/^\./, ""))
					.filter(Boolean)
					.map((host) => `https://${host}/`),
			),
		];

		// When connected to the user's already-authenticated Chrome context, these
		// cookies usually already exist. Avoid rewriting them: apart from being
		// redundant, flattening a Cookie header loses host-only/SameSite metadata.
		let missing = normalized;
		try {
			const existing = urls.length > 0 ? await ctx.cookies(urls) : [];
			missing = normalized.filter(
				(cookie) =>
					!existing.some(
						(current) => current.name === cookie.name && current.value === cookie.value,
					),
			);
		} catch {
			// If inspection fails, fall through to normalized injection.
		}
		if (missing.length === 0) return;

		try {
			await ctx.addCookies(missing);
		} catch (err) {
			// A single provider-specific cookie should not poison the whole batch.
			// Retry individually so valid cookies are retained and diagnostics name
			// only the entries Chrome actually rejects.
			const rejected: string[] = [];
			for (const cookie of missing) {
				try {
					await ctx.addCookies([cookie]);
				} catch {
					rejected.push(cookie.name);
				}
			}
			if (rejected.length > 0) {
				console.warn(
					`[BrowserManager] addCookies rejected ${rejected.join(", ")}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}

	async isHealthy(): Promise<boolean> {
		if (this.disconnected || !this.browser || !this.context) {
			const cdpUrl = getDefaultCdpUrl();
			const ws = await getChromeWebSocketUrl(cdpUrl, 3000);
			return ws !== null;
		}

		try {
			const pages = this.context.pages();
			return pages.length >= 0;
		} catch {
			return false;
		}
	}

	async shutdown(): Promise<void> {
		if (this.browser) {
			try {
				this.browser.removeAllListeners("disconnected");
				await this.browser.close().catch(() => {});
			} catch {
				// ignore
			}
		}
		this.browser = null;
		this.context = null;
		this.disconnected = true;
		this.connecting = null;
	}

	private async connect(): Promise<BrowserContext> {
		const cdpUrl = getDefaultCdpUrl();
		console.log(`[BrowserManager] Connecting to Chrome at ${cdpUrl}...`);

		let wsUrl: string | null = null;
		for (let attempt = 0; attempt < 15; attempt++) {
			wsUrl = await getChromeWebSocketUrl(cdpUrl, 2000);
			if (wsUrl) break;
			if (attempt === 2) await this.tryAutoStartChrome();
			await new Promise((r) => setTimeout(r, 1000));
		}

		if (!wsUrl) {
			throw new Error(
				`[BrowserManager] Failed to connect to Chrome at ${cdpUrl}. ` +
					"Make sure Chrome is running in debug mode (token-free-gateway chrome start).",
			);
		}

		const browser = await chromium.connectOverCDP(wsUrl, {
			headers: getHeadersWithAuth(wsUrl),
		});

		const ctx = browser.contexts()[0];
		if (!ctx) throw new Error("[BrowserManager] CDP connection returned no browser context");

		this.browser = browser;
		this.context = ctx;
		this.disconnected = false;

		browser.on("disconnected", () => {
			console.warn("[BrowserManager] Chrome disconnected. Will auto-reconnect on next request.");
			this.browser = null;
			this.context = null;
			this.disconnected = true;
		});

		for (const page of ctx.pages()) watchProviderNavigation(page);
		ctx.on("page", (page) => watchProviderNavigation(page));

		const pageCount = ctx.pages().length;
		console.log(
			`[BrowserManager] Connected successfully (${pageCount} existing tab${pageCount !== 1 ? "s" : ""})`,
		);
		console.log("[BrowserManager] Provider runtime discovery enabled for Claude, Qwen, and Kimi");

		return ctx;
	}

	private async tryAutoStartChrome(): Promise<void> {
		try {
			console.log("[BrowserManager] Chrome not reachable, attempting auto-start...");
			const { startChrome } = await import("../cli/chrome.ts");
			await startChrome();
		} catch (err) {
			console.warn(
				`[BrowserManager] Auto-start failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

export { BrowserManager };
