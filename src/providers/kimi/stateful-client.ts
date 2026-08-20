import type { Page } from "playwright-core";
import { BrowserManager } from "../../browser/manager.ts";
import type { NormalizedSendParams } from "../factory/types.ts";
import { runtimeProfiles } from "../runtime-profile.ts";
import type { EvalResult } from "../shared/eval-helpers.ts";
import { KimiWebClient } from "./client.ts";

const KIMI_FALLBACK_ORIGIN = "https://www.kimi.ai";
const KIMI_CHAT_PATH = "/apiv2/kimi.gateway.chat.v1.ChatService/Chat";

type StatefulKimiResult =
	| {
			ok: true;
			text: string;
			chatId: string;
			parentMessageId: string;
	  }
	| {
			ok: false;
			status: number;
			error: string;
	  };

/**
 * Reuses Kimi's upstream chat_id + rolling message.id for explicit stable
 * gateway sessions. Stateless calls delegate to the existing Kimi client.
 */
export class KimiStatefulWebClient extends KimiWebClient {
	private chatId: string | undefined;
	private parentMessageId: string | undefined;

	override async close(): Promise<void> {
		this.resetStatefulConversation();
		await super.close();
	}

	protected override async callApi(page: Page, params: NormalizedSendParams): Promise<EvalResult> {
		if (!params.statefulSession) return super.callApi(page, params);
		if (!params.sessionId) {
			return {
				ok: false,
				status: 400,
				error: "Kimi stateful request requires a stable session id",
			};
		}
		if (params.resetSession) this.resetStatefulConversation();

		const result = await this.callStatefulApi(page, params);
		if (!result.ok) {
			this.resetStatefulConversation();
			return result;
		}

		this.chatId = result.chatId;
		this.parentMessageId = result.parentMessageId;
		console.log(`[Kimi Web] Stateful chatId=${this.chatId} parentMessageId=${this.parentMessageId}`);
		const escaped = JSON.stringify(result.text);
		return { ok: true, data: `data: {"text":${escaped}}\n\ndata: [DONE]\n\n` };
	}

	private resetStatefulConversation(): void {
		this.chatId = undefined;
		this.parentMessageId = undefined;
	}

	private getStatefulRuntimeTarget(): { origin: string; endpoint: string } {
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

	private async callStatefulApi(
		page: Page,
		params: NormalizedSendParams,
	): Promise<StatefulKimiResult> {
		const { origin, endpoint } = this.getStatefulRuntimeTarget();
		const bm = BrowserManager.getInstance();
		const ctx = await bm.getContext();
		const cookies = await ctx.cookies([origin]);
		const kimiAuthCookie = cookies.find((c) => c.name === "kimi-auth" && c.value)?.value;
		const accessTokenCookie = cookies.find((c) => c.name === "access_token" && c.value)?.value;
		const authCandidates = [kimiAuthCookie, accessTokenCookie, this.auth.accessToken]
			.filter((value): value is string => typeof value === "string" && value.trim().length >= 20)
			.map((value) => value.trim())
			.filter((value, index, all) => all.indexOf(value) === index);

		if (authCandidates.length === 0) {
			return {
				ok: false,
				status: 401,
				error: "Kimi: no credentials. Run webauth to refresh login.",
			};
		}

		const scenario = params.model.includes("search")
			? "SCENARIO_SEARCH"
			: params.model.includes("research")
				? "SCENARIO_RESEARCH"
				: params.model.includes("k1")
					? "SCENARIO_K1"
					: "SCENARIO_K2";
		let lastAuthError: StatefulKimiResult | undefined;

		for (const authToken of authCandidates) {
			const result = (await page.evaluate(
				async ({
					origin,
					endpoint,
					message,
					kimiAuthToken,
					scenario,
					chatId,
					parentMessageId,
				}) => {
					const req = {
						chat_id: chatId,
						scenario,
						tools: [],
						message: {
							id: "",
							parent_id: parentMessageId,
							children_message_ids: [],
							role: "user" as const,
							blocks: [
								{
									id: "",
									message_id: "",
									text: { content: message },
								},
							],
							scenario,
							labels: [],
							references: [],
							is_goal: false,
						},
						options: { thinking: false },
					};
					const encoded = new TextEncoder().encode(JSON.stringify(req));
					const buffer = new ArrayBuffer(5 + encoded.byteLength);
					const view = new DataView(buffer);
					view.setUint8(0, 0x00);
					view.setUint32(1, encoded.byteLength, false);
					new Uint8Array(buffer, 5).set(encoded);

					const referer = chatId ? `${origin}/chat/${chatId}` : `${origin}/`;
					const res = await fetch(endpoint, {
						method: "POST",
						headers: {
							"Content-Type": "application/connect+json",
							"Connect-Protocol-Version": "1",
							Accept: "*/*",
							Origin: origin,
							Referer: referer,
							"X-Language": "en-US",
							"X-Msh-Platform": "web",
							Authorization: `Bearer ${kimiAuthToken}`,
						},
						body: buffer,
					});
					if (!res.ok) {
						const text = await res.text();
						return {
							ok: false as const,
							status: res.status,
							error: `Kimi ${endpoint} returned HTTP ${res.status}: ${text.slice(0, 600)}`,
						};
					}

					const bytes = new Uint8Array(await res.arrayBuffer());
					const texts: string[] = [];
					let nextChatId = chatId;
					let nextParentMessageId = parentMessageId;
					let offset = 0;
					while (offset + 5 <= bytes.length) {
						const flags = bytes[offset] ?? 0;
						const length = new DataView(
							bytes.buffer,
							bytes.byteOffset + offset + 1,
							4,
						).getUint32(0, false);
						if (offset + 5 + length > bytes.length) break;
						const frame = bytes.slice(offset + 5, offset + 5 + length);
						offset += 5 + length;
						if ((flags & 0x02) !== 0) continue;

						try {
							const obj = JSON.parse(new TextDecoder().decode(frame));
							if (obj.error) {
								return {
									ok: false as const,
									status: 502,
									error:
										obj.error.message || obj.error.code || JSON.stringify(obj.error).slice(0, 400),
								};
							}
							if (typeof obj.chat?.id === "string" && obj.chat.id) nextChatId = obj.chat.id;
							if (typeof obj.message?.id === "string" && obj.message.id) {
								nextParentMessageId = obj.message.id;
							}

							const op = obj.op || "";
							if (obj.delta?.content) texts.push(obj.delta.content);
							if (obj.block?.text?.content && (op === "append" || op === "set" || !op)) {
								texts.push(obj.block.text.content);
							} else if (obj.text?.content && (op === "append" || op === "set" || !op)) {
								texts.push(obj.text.content);
							}
							if (
								obj.message?.role === "assistant" &&
								Array.isArray(obj.message?.blocks) &&
								(op === "set" || op === "append" || !op)
							) {
								for (const block of obj.message.blocks) {
									if (block?.text?.content) texts.push(block.text.content);
								}
							}
						} catch {
							// Ignore non-JSON Connect control frames.
						}
					}

					if (!nextChatId) {
						return {
							ok: false as const,
							status: 502,
							error: "Kimi stateful response did not expose chat.id",
						};
					}
					if (!nextParentMessageId) {
						return {
							ok: false as const,
							status: 502,
							error: "Kimi stateful response did not expose message.id",
						};
					}
					if (texts.length === 0) {
						return {
							ok: false as const,
							status: 502,
							error: `Kimi returned ${bytes.length} bytes but no assistant text was decoded`,
						};
					}
					return {
						ok: true as const,
						text: texts.join(""),
						chatId: nextChatId,
						parentMessageId: nextParentMessageId,
					};
				},
				{
					origin,
					endpoint,
					message: params.message,
					kimiAuthToken: authToken,
					scenario,
					chatId: this.chatId ?? "",
					parentMessageId: this.parentMessageId ?? "",
				},
			)) as StatefulKimiResult;

			if (result.ok) return result;
			if (result.status !== 401) return result;
			lastAuthError = result;
		}

		return (
			lastAuthError ?? {
				ok: false,
				status: 401,
				error: "Kimi authentication failed. Re-run webauth while logged in to kimi.ai.",
			}
		);
	}
}
