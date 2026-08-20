import type { Page } from "playwright-core";
import { BrowserManager } from "../../browser/manager.ts";
import { BaseApiClient } from "../factory/base-api-client.ts";
import type { ApiClientConfig, NormalizedSendParams } from "../factory/types.ts";
import { type BrowserCookie, parseCookieHeader } from "../shared/cookie-parser.ts";
import type { EvalResult } from "../shared/eval-helpers.ts";
import type { StreamResult } from "../types.ts";
import type { KimiWebAuth } from "./auth.ts";
import { parseKimiStream } from "./stream.ts";

function normalizeSiteUrl(siteUrl?: string): string {
	try {
		const url = new URL(siteUrl || "https://www.kimi.com/");
		if (url.hostname.endsWith("kimi.ai") || url.hostname.endsWith("kimi.com")) {
			return url.origin;
		}
	} catch {
		/* fall through */
	}
	return "https://www.kimi.com";
}

export class KimiWebClient extends BaseApiClient<KimiWebAuth> {
	readonly providerId = "kimi-web";

	protected readonly config: ApiClientConfig = {
		hostKey: "kimi",
		startUrl: "https://www.kimi.com/",
		cookieDomain: ".kimi.com",
		defaultModel: "moonshot-v1-32k",
		models: [
			{ id: "moonshot-v1-8k", name: "Moonshot v1 8K" },
			{ id: "moonshot-v1-32k", name: "Moonshot v1 32K" },
			{ id: "moonshot-v1-128k", name: "Moonshot v1 128K" },
		],
	};

	private readonly baseUrl: string;
	private readonly cookieDomain: string;

	constructor(auth: KimiWebAuth) {
		super(auth);
		this.baseUrl = normalizeSiteUrl(auth.siteUrl);
		this.cookieDomain = new URL(this.baseUrl).hostname.endsWith("kimi.ai") ? ".kimi.ai" : ".kimi.com";
	}

	protected getCookies(): BrowserCookie[] {
		return [];
	}

	/** Reuse the authenticated Kimi variant and keep cookies scoped to that site. */
	protected override async getPage(): Promise<Page> {
		if (this.page) {
			try {
				await this.page.evaluate(() => document.readyState);
				return this.page;
			} catch {
				this.page = null;
			}
		}

		const bm = BrowserManager.getInstance();
		const hostKey = new URL(this.baseUrl).hostname;
		this.page = await bm.getPage(hostKey, `${this.baseUrl}/`);

		const cookie = this.auth.cookie || "";
		if (cookie.trim()) {
			const cookies = parseCookieHeader(cookie, this.cookieDomain).map((c) => ({
				...c,
				...(c.name.startsWith("__Secure-") || c.name.startsWith("__Host-") ? { secure: true } : {}),
			}));
			if (cookies.length > 0) await bm.addCookies(cookies);
		}
		return this.page;
	}

	protected async callApi(page: Page, params: NormalizedSendParams): Promise<EvalResult> {
		const bm = BrowserManager.getInstance();
		const ctx = await bm.getContext();
		const cookies = await ctx.cookies([this.baseUrl]);
		const kimiAuthCookie = cookies.find((c) => c.name === "kimi-auth" || c.name === "access_token")?.value;
		const authToken = this.auth.accessToken || kimiAuthCookie;
		if (!authToken) {
			return {
				ok: false,
				status: 401,
				error: `Kimi: no credentials for ${this.baseUrl}. Run webauth to refresh login.`,
			};
		}

		const model = params.model;
		const result = await page.evaluate(
			async ({
				baseUrl,
				message,
				kimiAuthToken,
				scenario,
			}: {
				baseUrl: string;
				message: string;
				kimiAuthToken: string;
				scenario: string;
			}) => {
				const req = {
					scenario,
					message: {
						role: "user" as const,
						blocks: [{ message_id: "", text: { content: message } }],
						scenario,
					},
					options: { thinking: false },
				};
				const enc = new TextEncoder().encode(JSON.stringify(req));
				const buf = new ArrayBuffer(5 + enc.byteLength);
				const dv = new DataView(buf);
				dv.setUint8(0, 0x00);
				dv.setUint32(1, enc.byteLength, false);
				new Uint8Array(buf, 5).set(enc);

				const endpoint = `${baseUrl}/apiv2/kimi.gateway.chat.v1.ChatService/Chat`;
				const res = await fetch(endpoint, {
					method: "POST",
					headers: {
						"Content-Type": "application/connect+json",
						"Connect-Protocol-Version": "1",
						Accept: "*/*",
						Origin: baseUrl,
						Referer: `${baseUrl}/`,
						"X-Language": "en-US",
						"X-Msh-Platform": "web",
						Authorization: `Bearer ${kimiAuthToken}`,
					},
					body: buf,
				});
				if (!res.ok) {
					const text = await res.text();
					return {
						ok: false as const,
						status: res.status,
						error: `Kimi ${endpoint} returned HTTP ${res.status}: ${text.slice(0, 600)}`,
					};
				}

				const arr = await res.arrayBuffer();
				const u8 = new Uint8Array(arr);
				const texts: string[] = [];
				let o = 0;
				while (o + 5 <= u8.length) {
					const len = new DataView(u8.buffer, u8.byteOffset + o + 1, 4).getUint32(0, false);
					if (o + 5 + len > u8.length) break;
					const chunk = u8.slice(o + 5, o + 5 + len);
					try {
						const obj = JSON.parse(new TextDecoder().decode(chunk));
						if (obj.error) {
							return {
								ok: false as const,
								status: 502,
								error: obj.error.message || obj.error.code || JSON.stringify(obj.error).slice(0, 400),
							};
						}
						const op = obj.op || "";
						if (obj.block?.text?.content && (op === "append" || op === "set")) {
							texts.push(obj.block.text.content);
						} else if (obj.text?.content && (op === "append" || op === "set")) {
							texts.push(obj.text.content);
						}
						if (!op && obj.message?.role === "assistant" && obj.message?.blocks) {
							for (const blk of obj.message.blocks) {
								if (blk.text?.content) texts.push(blk.text.content);
							}
						}
						if (obj.done) break;
					} catch {
						/* ignore non-JSON control frames */
					}
					o += 5 + len;
				}

				if (texts.length === 0) {
					return {
						ok: false as const,
						status: 502,
						error: `Kimi returned ${u8.length} bytes but no assistant text was decoded`,
					};
				}
				return { ok: true as const, text: texts.join("") };
			},
			{
				baseUrl: this.baseUrl,
				message: params.message,
				kimiAuthToken: authToken,
				scenario: model.includes("search")
					? "SCENARIO_SEARCH"
					: model.includes("research")
						? "SCENARIO_RESEARCH"
						: model.includes("k1")
							? "SCENARIO_K1"
							: "SCENARIO_K2",
			},
		);

		if (!result.ok) {
			console.error(`[Kimi Web] ${this.baseUrl}: ${"error" in result ? result.error : "Unknown error"}`);
			return {
				ok: false,
				status: ("status" in result ? result.status : 502) as number,
				error: ("error" in result ? result.error : "Unknown error") as string,
			};
		}
		const escaped = JSON.stringify(result.text);
		return { ok: true, data: `data: {"text":${escaped}}\n\ndata: [DONE]\n\n` };
	}

	protected parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return parseKimiStream(body, onDelta);
	}
}
