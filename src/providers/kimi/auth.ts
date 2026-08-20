import { chromium } from "playwright-core";
import {
	getChromeWebSocketUrl,
	getDefaultCdpUrl,
	getHeadersWithAuth,
} from "../../browser/cdp-helpers.ts";

export interface KimiWebAuth {
	cookie: string;
	userAgent: string;
	accessToken?: string;
	refreshToken?: string;
	/** Site variant used during authentication. Runtime may still use the shared Kimi web backend. */
	siteUrl?: string;
}

const KIMI_AUTH_URLS = ["https://www.kimi.ai/", "https://www.kimi.com/"] as const;
const KIMI_HOST_RE = /(^|\.)(kimi\.ai|kimi\.com|moonshot\.cn)$/i;

function isKimiUrl(url: string): boolean {
	try {
		return KIMI_HOST_RE.test(new URL(url).hostname);
	} catch {
		return false;
	}
}

function cookieHeader(cookies: Array<{ name: string; value: string; domain: string }>): string {
	return cookies
		.filter((c) => KIMI_HOST_RE.test(c.domain.replace(/^\./, "")))
		.map((c) => `${c.name}=${c.value}`)
		.join("; ");
}

function findCookieToken(
	cookies: Array<{ name: string; value: string; domain: string }>,
): string | undefined {
	// Only accept credential names known to be used by Kimi. Avoid generic
	// cookies named "token", which can belong to unrelated site features.
	const preferred = ["kimi-auth", "access_token", "access-token"];
	for (const name of preferred) {
		const hit = cookies.find(
			(c) => KIMI_HOST_RE.test(c.domain.replace(/^\./, "")) && c.name === name && c.value,
		);
		if (hit?.value) return hit.value;
	}
	return undefined;
}

function looksLikeCredential(value?: string): value is string {
	if (!value) return false;
	const v = value.trim();
	return v.length >= 20 && v !== "undefined" && v !== "null";
}

async function readStorageTokens(page: import("playwright-core").Page): Promise<{
	accessToken?: string;
	refreshToken?: string;
}> {
	try {
		return await page.evaluate(() => {
			const first = (...keys: string[]) => {
				for (const key of keys) {
					const value = localStorage.getItem(key) || sessionStorage.getItem(key);
					if (value) return value;
				}
				return undefined;
			};
			return {
				accessToken: first("access_token", "accessToken", "kimi-auth"),
				refreshToken: first("refresh_token", "refreshToken"),
			};
		});
	} catch {
		return {};
	}
}

export async function loginKimiWeb(params: {
	onProgress: (msg: string) => void;
	openUrl: (url: string) => Promise<boolean>;
}): Promise<KimiWebAuth> {
	const cdpUrl = getDefaultCdpUrl();
	params.onProgress("Connecting to Chrome debug port...");

	let wsUrl: string | null = null;
	for (let i = 0; i < 10; i++) {
		wsUrl = await getChromeWebSocketUrl(cdpUrl, 2000);
		if (wsUrl) break;
		await new Promise((r) => setTimeout(r, 500));
	}
	if (!wsUrl) {
		throw new Error(
			`Failed to connect to Chrome at ${cdpUrl}. Make sure Chrome is running in debug mode (./start-chrome-debug.sh)`,
		);
	}

	params.onProgress("Connecting to browser...");
	const browser = await chromium.connectOverCDP(wsUrl, {
		headers: getHeadersWithAuth(wsUrl),
	});
	const context = browser.contexts()[0];
	if (!context) throw new Error("No browser context available");

	const pages = context.pages();
	let page =
		pages.find((p) => {
			try {
				return new URL(p.url()).hostname.endsWith("kimi.ai");
			} catch {
				return false;
			}
		}) ?? pages.find((p) => isKimiUrl(p.url()));

	if (!page) {
		page = pages[0] || (await context.newPage());
		params.onProgress("Opening Kimi international (kimi.ai)...");
		await params.openUrl(KIMI_AUTH_URLS[0]);
		try {
			await page.goto(KIMI_AUTH_URLS[0], { waitUntil: "domcontentloaded" });
		} catch {
			params.onProgress("kimi.ai did not load; falling back to kimi.com...");
			await page.goto(KIMI_AUTH_URLS[1], { waitUntil: "domcontentloaded" });
		}
	} else {
		params.onProgress(`Using existing Kimi tab: ${page.url()}`);
	}

	params.onProgress("Please login in the browser window...");
	params.onProgress("Waiting for Kimi authentication on kimi.ai or kimi.com...");

	const deadline = Date.now() + 300_000;
	let accessToken: string | undefined;
	let refreshToken: string | undefined;
	let matchedPage = page;

	while (Date.now() < deadline) {
		const kimiPages = context.pages().filter((p) => isKimiUrl(p.url()));
		if (kimiPages.length > 0) {
			matchedPage =
				kimiPages.find((p) => {
					try {
						return new URL(p.url()).hostname.endsWith("kimi.ai");
					} catch {
						return false;
					}
				}) ?? kimiPages[0]!;
		}

		const storage = await readStorageTokens(matchedPage);
		const cookies = await context.cookies();
		const candidate = storage.accessToken || findCookieToken(cookies);
		accessToken = looksLikeCredential(candidate) ? candidate.trim() : undefined;
		refreshToken = looksLikeCredential(storage.refreshToken)
			? storage.refreshToken.trim()
			: undefined;

		if (accessToken) break;
		await new Promise((r) => setTimeout(r, 1000));
	}

	if (!accessToken) {
		throw new Error(
			"Kimi login was not detected within 5 minutes on kimi.ai/kimi.com. Keep the authenticated Kimi tab open and try again.",
		);
	}

	params.onProgress("Login detected, capturing credentials...");
	const cookies = await context.cookies();
	const cookieString = cookieHeader(cookies);
	const userAgent = await matchedPage.evaluate(() => navigator.userAgent);
	const siteUrl = isKimiUrl(matchedPage.url())
		? new URL(matchedPage.url()).origin
		: KIMI_AUTH_URLS[0];

	params.onProgress(`Authentication captured successfully from ${siteUrl}`);

	return {
		cookie: cookieString,
		accessToken,
		refreshToken,
		userAgent,
		siteUrl,
	};
}
