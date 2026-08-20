import type { Page } from "playwright-core";
import { BrowserManager } from "../../browser/manager.ts";
import { BaseApiClient } from "../factory/base-api-client.ts";
import type { ApiClientConfig, NormalizedSendParams } from "../factory/types.ts";
import { runtimeProfiles } from "../runtime-profile.ts";
import { type BrowserCookie, parseCookieHeader } from "../shared/cookie-parser.ts";
import type { EvalResult } from "../shared/eval-helpers.ts";
import type { StreamResult } from "../types.ts";
import type { KimiWebAuth } from "./auth.ts";
import { parseKimiStream } from "./stream.ts";

const KIMI_FALLBACK_ORIGIN = "https://www.kimi.ai";
const KIMI_CHAT_PATH = "/apiv2/kimi.gateway.chat.v1.ChatService/Chat";

export class KimiWebClient extends BaseApiClient<KimiWebAuth> {
	readonly providerId = "kimi-web";

	protected readonly config: ApiClientConfig = {
		hostKey: "kimi.ai",
		startUrl: `${KIMI_FALLBACK_ORIGIN}/`,
		cookieDomain: ".kimi.ai",
		defaultModel: "moonshot-v1-32k",
		models: [
			{ id: "moonshot-v1-8k", name: "Moonshot v1 8K" },
			{ id: "moonshot-v1-32k", name: "Moonshot v1 32K" },
			{ id: "moonshot-v1-128k", name: "Moonshot v1 128K" },
		],
	};

	protected getCookies(): BrowserCookie[] {
		return [];
	}

	private getRuntimeTarget(): { origin: string; endpoint: string } {
		const profile = runtimeProfiles.get(this.providerId);
		const origin = profile?.origin?.startsWith("https://")
			? profile.origin
			: this.auth.siteUrl?.startsWith("https://")
				? this.auth.siteUrl
				: KIMI_FALLBACK_ORIGIN;
		const endpoint = profile?.endpoint?.includes("kimi.gateway.chat.v1.ChatService/Chat")
			? profile.endpoint
			: `${origin}${KIMI_CHAT_PATH}`;
		return { origin, endpoint };
	}

	protected override async getPage(): Promise<Page> {
		const { origin } = this.getRuntimeTarget();
		if (this.page) {
			try {
				const current = new URL(this.page.url());
				if (current.origin === origin) {
					await this.page.evaluate(() => document.readyState);
					return this.page;
				}
			} catch {
				// Re-resolve the page below.
			}
			this.page = null;
		}

		const bm = BrowserManager.getInstance();
		this.page = await bm.getPage(new URL(origin).hostname, `${origin}/`);

		const cookie = this.auth.cookie || "";
		if (cookie.trim()) {
			const cookies = parseCookieHeader(
				cookie,
				`.${new URL(origin).hostname.replace(/^www\./, "")}`,
			).map((c) => ({
				...c,
				...(c.name.startsWith("__Secure-") || c.name.startsWith("__Host-") ? { secure: true } : {}),
			}));
			if (cookies.length > 0) await bm.addCookies(cookies);
		}
		return this.page;
	}

	protected async callApi(page: Page, params: NormalizedSendParams): Promise<EvalResult> {
		const { origin, endpoint } = this.getRuntimeTarget();
		const bm = BrowserManager.getInstance();
		const ctx = await bm.getContext();
		const cookies = await ctx.cookies([origin]);

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
					origin,
					endpoint,
					message,
					kimiAuthToken,
					scenario,
				}: {
					origin: string;
					endpoint: string;
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

					const res = await fetch(endpoint, {
						method: "POST",
						headers: {
							"Content-Type": "application/connect+json",
							"Connect-Protocol-Version": "1",
							Accept: "*/*",
							Origin: origin,
							Referer: `${origin}/`,
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
							if (framePreview.length < 12)
								framePreview.push(`flags=${flags} ${decoded.slice(0, 500)}`);
							if (obj.error) {
								return {
									ok: false as const,
									status: 502,
									error:
										obj.error.message || obj.error.code || JSON.stringify(obj.error).slice(0, 400),
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
					origin,
					endpoint,
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

			if (("status" in result ? result.status : 0) !== 401) {
				console.error(
					`[Kimi Web] ${endpoint}: ${"error" in result ? result.error : "Unknown error"}`,
				);
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

		console.error(`[Kimi Web] all available credentials were rejected by ${endpoint}`);
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
