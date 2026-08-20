import type { Page } from "playwright-core";
import { BrowserManager } from "../../browser/manager.ts";
import { BaseApiClient } from "../factory/base-api-client.ts";
import type { ApiClientConfig, NormalizedSendParams } from "../factory/types.ts";
import { type BrowserCookie, parseCookieHeader } from "../shared/cookie-parser.ts";
import type { EvalResult } from "../shared/eval-helpers.ts";
import type { StreamResult } from "../types.ts";
import type { KimiWebAuth } from "./auth.ts";
import { parseKimiStream } from "./stream.ts";

const KIMI_CHAT_BASE_URL = "https://www.kimi.com";

export class KimiWebClient extends BaseApiClient<KimiWebAuth> {
	readonly providerId = "kimi-web";

	protected readonly config: ApiClientConfig = {
		hostKey: "kimi.com",
		startUrl: "https://www.kimi.com/",
		cookieDomain: ".kimi.com",
		defaultModel: "moonshot-v1-32k",
		models: [
			{ id: "moonshot-v1-8k", name: "Moonshot v1 8K" },
			{ id: "moonshot-v1-32k", name: "Moonshot v1 32K" },
			{ id: "moonshot-v1-128k", name: "Moonshot v1 128K" },
		],
	};

	private readonly baseUrl = KIMI_CHAT_BASE_URL;

	protected getCookies(): BrowserCookie[] {
		return [];
	}

	/**
	 * Authentication may be captured from kimi.ai, but the international chat
	 * transport is served by www.kimi.com.
	 */
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
		this.page = await bm.getPage(this.config.hostKey, this.config.startUrl);

		const cookie = this.auth.cookie || "";
		if (cookie.trim()) {
			const cookies = parseCookieHeader(cookie, ".kimi.com").map((c) => ({
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

		// Prefer live browser credentials. Kimi rotates authentication and a token
		// saved by webauth can become stale while the browser session is still valid.
		const kimiAuthCookie = cookies.find((c) => c.name === "kimi-auth" && c.value)?.value;
		const accessTokenCookie = cookies.find((c) => c.name === "access_token" && c.value)?.value;
		const authCandidates = [kimiAuthCookie, accessTokenCookie, this.auth.accessToken]
			.filter((v): v is string => typeof v === "string" && v.trim().length >= 20)
			.map((v) => v.trim())
			.filter((v, i, arr) => arr.indexOf(v) === i);

		if (authCandidates.length === 0) {
			return {
				ok: false,
				status: 401,
				error: "Kimi: no credentials. Run webauth to refresh login.",
			};
		}

		const model = params.model;
		let lastAuthError: EvalResult | null = null;

		for (const authToken of authCandidates) {
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
					const framePreview: string[] = [];
					let o = 0;
					while (o + 5 <= u8.length) {
						const flags = u8[o] ?? 0;
						const len = new DataView(u8.buffer, u8.byteOffset + o + 1, 4).getUint32(0, false);
						if (o + 5 + len > u8.length) break;
						const chunk = u8.slice(o + 5, o + 5 + len);
						try {
							const decoded = new TextDecoder().decode(chunk);
							const obj = JSON.parse(decoded);
							if (framePreview.length < 12) framePreview.push(`flags=${flags} ${decoded.slice(0, 500)}`);
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

							if (
								obj.message?.role === "assistant" &&
								Array.isArray(obj.message?.blocks) &&
								(op === "set" || op === "append" || !op)
							) {
								for (const blk of obj.message.blocks) {
									if (blk?.text?.content) texts.push(blk.text.content);
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
							error: `Kimi returned ${u8.length} bytes but no assistant text was decoded. Frames: ${framePreview.join(" | ")}`,
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

			if (result.ok) {
				const escaped = JSON.stringify(result.text);
				return { ok: true, data: `data: {"text":${escaped}}\n\ndata: [DONE]\n\n` };
			}

			// Only try another credential when this candidate is explicitly rejected.
			// Other failures (protocol/parser/server errors) should surface immediately.
			if (("status" in result ? result.status : 0) !== 401) {
				console.error(`[Kimi Web] ${this.baseUrl}: ${"error" in result ? result.error : "Unknown error"}`);
				return {
					ok: false,
					status: ("status" in result ? result.status : 502) as number,
					error: ("error" in result ? result.error : "Unknown error") as string,
				};
			}

			lastAuthError = {
				ok: false,
				status: 401,
				error: ("error" in result ? result.error : "Authentication failed") as string,
			};
		}

		console.error(`[Kimi Web] all available credentials were rejected by ${this.baseUrl}`);
		return (
			lastAuthError ?? {
				ok: false,
				status: 401,
				error: "Kimi authentication failed. Re-run webauth while logged in to kimi.ai.",
			}
		);
	}

	protected parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return parseKimiStream(body, onDelta);
	}
}
