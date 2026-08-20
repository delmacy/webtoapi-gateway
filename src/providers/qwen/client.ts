import crypto from "node:crypto";
import type { Page } from "playwright-core";
import { BaseApiClient } from "../factory/base-api-client.ts";
import type { ApiClientConfig, NormalizedSendParams } from "../factory/types.ts";
import { parseCookieHeader } from "../shared/cookie-parser.ts";
import type { EvalResult } from "../shared/eval-helpers.ts";
import type { StreamResult } from "../types.ts";
import type { QwenWebAuth } from "./auth.ts";
import { parseQwenStream } from "./stream.ts";

const QWEN_WEB_VERSION = "0.2.83";

export class QwenWebClient extends BaseApiClient<QwenWebAuth> {
	readonly providerId = "qwen-web";

	protected readonly config: ApiClientConfig = {
		hostKey: "qwen.ai",
		startUrl: "https://chat.qwen.ai/",
		cookieDomain: ".qwen.ai",
		defaultModel: "qwen3.5-plus",
		models: [
			{ id: "qwen3.5-plus", name: "Qwen 3.5 Plus" },
			{ id: "qwen3.5-turbo", name: "Qwen 3.5 Turbo" },
		],
	};

	private readonly baseUrl = "https://chat.qwen.ai";

	protected getCookies() {
		return parseCookieHeader(
			this.auth.cookie || `qwen_session=${this.auth.sessionToken}`,
			this.config.cookieDomain,
		);
	}

	protected async callApi(page: Page, params: NormalizedSendParams): Promise<EvalResult> {
		const createChatTimeoutMs = 30_000;
		const createRequestId = crypto.randomUUID();
		const createChatResult = await page.evaluate(
			async ({ baseUrl, timeoutMs, model, requestId, version }) => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					const url = `${baseUrl}/api/v2/chats/new`;
					const controller = new AbortController();
					timer = setTimeout(() => controller.abort(), timeoutMs);
					const res = await fetch(url, {
						method: "POST",
						headers: {
							Accept: "application/json",
							"Content-Type": "application/json",
							Origin: baseUrl,
							Referer: `${baseUrl}/`,
							source: "web",
							version,
							"x-request-id": requestId,
						},
						body: JSON.stringify({
							title: "New Chat",
							models: [model],
							chat_mode: "normal",
							chat_type: "t2t",
							timestamp: Date.now(),
							project_id: "",
						}),
						signal: controller.signal,
					});
					if (!res.ok) {
						const errorText = await res.text();
						return { ok: false as const, status: res.status, error: errorText };
					}
					const data = await res.json();
					const chatId = data.data?.id ?? data.chat_id ?? data.id ?? data.chatId;
					if (!chatId) {
						return {
							ok: false as const,
							status: 502,
							error: `Qwen create-chat returned no chat id: ${JSON.stringify(data).slice(0, 400)}`,
						};
					}
					return { ok: true as const, chatId };
				} catch (err) {
					const msg = String(err);
					if (msg.includes("aborted") || msg.includes("signal")) {
						return {
							ok: false as const,
							status: 408,
							error: `Create chat timed out after ${timeoutMs}ms`,
						};
					}
					return { ok: false as const, status: 500, error: msg };
				} finally {
					if (typeof timer !== "undefined") clearTimeout(timer);
				}
			},
			{
				baseUrl: this.baseUrl,
				timeoutMs: createChatTimeoutMs,
				model: params.model,
				requestId: createRequestId,
				version: QWEN_WEB_VERSION,
			},
		);

		if (!createChatResult.ok || !createChatResult.chatId) {
			return {
				ok: false,
				status: (createChatResult as { status?: number }).status ?? 500,
				error: (createChatResult as { error?: string }).error || "No chat_id in response",
			};
		}

		const chatId = createChatResult.chatId as string;
		const fetchTimeoutMs = 300_000;
		const fid = crypto.randomUUID();
		const childId = crypto.randomUUID();
		const requestId = crypto.randomUUID();
		const responseData = await page.evaluate(
			async ({ baseUrl, chatId, model, message, fid, childId, requestId, timeoutMs, version }) => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					const url = `${baseUrl}/api/v2/chat/completions?chat_id=${chatId}`;
					const controller = new AbortController();
					timer = setTimeout(() => controller.abort(), timeoutMs);
					const requestBody = {
						stream: true,
						version: "2.1",
						incremental_output: true,
						chat_id: chatId,
						chat_mode: "normal",
						model,
						parent_id: null,
						messages: [
							{
								id: null,
								fid,
								parentId: null,
								childrenIds: [childId],
								role: "user",
								content: message,
								user_action: "chat",
								files: [],
								timestamp: Date.now(),
								models: [model],
								model: "",
								chat_type: "t2t",
								feature_config: {
									thinking_enabled: true,
									output_schema: "phase",
									research_mode: "normal",
									auto_thinking: true,
									thinking_mode: "Auto",
									thinking_format: "summary",
									auto_search: false,
								},
								extra: { meta: { subChatType: "t2t" } },
								sub_chat_type: "t2t",
								parent_id: null,
							},
						],
						timestamp: Date.now(),
					};
					const res = await fetch(url, {
						method: "POST",
						headers: {
							Accept: "text/event-stream",
							"Content-Type": "application/json",
							Origin: baseUrl,
							Referer: `${baseUrl}/`,
							source: "web",
							version,
							"x-request-id": requestId,
						},
						body: JSON.stringify(requestBody),
						signal: controller.signal,
					});
					if (!res.ok) {
						const errorText = await res.text();
						return { ok: false as const, status: res.status, error: errorText };
					}
					const reader = res.body?.getReader();
					if (!reader) return { ok: false as const, status: 500, error: "No response body" };
					const decoder = new TextDecoder();
					let fullText = "";
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						fullText += decoder.decode(value, { stream: true });
						if (fullText.includes("data: [DONE]")) {
							await reader.cancel();
							break;
						}
					}
					fullText += decoder.decode();
					return { ok: true as const, data: fullText };
				} catch (err) {
					const msg = String(err);
					if (msg.includes("aborted") || msg.includes("signal")) {
						return {
							ok: false as const,
							status: 408,
							error: `Qwen API request timed out after ${timeoutMs}ms`,
						};
					}
					return { ok: false as const, status: 500, error: msg };
				} finally {
					if (typeof timer !== "undefined") clearTimeout(timer);
				}
			},
			{
				baseUrl: this.baseUrl,
				chatId,
				model: params.model,
				message: params.message,
				fid,
				childId,
				requestId,
				timeoutMs: fetchTimeoutMs,
				version: QWEN_WEB_VERSION,
			},
		);

		return responseData as EvalResult;
	}

	protected parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return parseQwenStream(body, onDelta);
	}
}
