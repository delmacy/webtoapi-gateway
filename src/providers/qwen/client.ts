import crypto from "node:crypto";
import type { Page } from "playwright-core";
import { BaseApiClient } from "../factory/base-api-client.ts";
import type { ApiClientConfig, NormalizedSendParams } from "../factory/types.ts";
import { runtimeProfiles } from "../runtime-profile.ts";
import { parseCookieHeader } from "../shared/cookie-parser.ts";
import type { EvalResult } from "../shared/eval-helpers.ts";
import type { StreamResult } from "../types.ts";
import type { QwenWebAuth } from "./auth.ts";
import { parseQwenStream } from "./stream.ts";

const QWEN_WEB_VERSION = "0.2.83";
const QWEN_FALLBACK_ORIGIN = "https://chat.qwen.ai";
const QWEN_CREATE_TIMEOUT_MS = 30_000;
const QWEN_STREAM_IDLE_TIMEOUT_MS = 45_000;

export class QwenWebClient extends BaseApiClient<QwenWebAuth> {
	readonly providerId = "qwen-web";

	protected readonly config: ApiClientConfig = {
		hostKey: "qwen.ai",
		startUrl: `${QWEN_FALLBACK_ORIGIN}/`,
		cookieDomain: ".qwen.ai",
		defaultModel: "qwen3.5-plus",
		models: [
			{ id: "qwen3.5-plus", name: "Qwen 3.5 Plus" },
			{ id: "qwen3.5-turbo", name: "Qwen 3.5 Turbo" },
		],
	};

	protected getCookies() {
		return parseCookieHeader(
			this.auth.cookie || `qwen_session=${this.auth.sessionToken}`,
			this.config.cookieDomain,
		);
	}

	private getRuntimeTarget(chatId?: string): { origin: string; completionEndpoint?: string; version: string } {
		const profile = runtimeProfiles.get(this.providerId);
		const origin = profile?.origin?.startsWith("https://") ? profile.origin : QWEN_FALLBACK_ORIGIN;
		let completionEndpoint: string | undefined;
		if (profile?.endpoint?.includes("/api/v2/chat/completions")) {
			try {
				const url = new URL(profile.endpoint);
				if (chatId) url.searchParams.set("chat_id", chatId);
				completionEndpoint = url.toString();
			} catch {
				completionEndpoint = undefined;
			}
		}
		return {
			origin,
			completionEndpoint,
			version: profile?.clientVersion || QWEN_WEB_VERSION,
		};
	}

	protected async callApi(page: Page, params: NormalizedSendParams): Promise<EvalResult> {
		const initialRuntime = this.getRuntimeTarget();
		const createRequestId = crypto.randomUUID();

		const createChatResult = await page.evaluate(
			async ({ baseUrl, timeoutMs, model, requestId, version }) => {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), timeoutMs);
				try {
					const res = await fetch(`${baseUrl}/api/v2/chats/new`, {
						method: "POST",
						headers: {
							Accept: "application/json, text/plain, */*",
							"Content-Type": "application/json",
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
						return { ok: false as const, status: res.status, error: await res.text() };
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
					return {
						ok: false as const,
						status: msg.includes("aborted") ? 408 : 500,
						error: msg.includes("aborted") ? `Create chat timed out after ${timeoutMs}ms` : msg,
					};
				} finally {
					clearTimeout(timer);
				}
			},
			{
				baseUrl: initialRuntime.origin,
				timeoutMs: QWEN_CREATE_TIMEOUT_MS,
				model: params.model,
				requestId: createRequestId,
				version: initialRuntime.version,
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
		const runtime = this.getRuntimeTarget(chatId);
		const fid = crypto.randomUUID();
		const childId = crypto.randomUUID();
		const requestId = crypto.randomUUID();

		const responseData = await page.evaluate(
			async ({ baseUrl, completionEndpoint, chatId, model, message, fid, childId, requestId, idleTimeoutMs, version }) => {
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

				const controller = new AbortController();
				let idleTimer: ReturnType<typeof setTimeout> | undefined;
				const resetIdle = () => {
					if (idleTimer) clearTimeout(idleTimer);
					idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
				};

				try {
					resetIdle();
					const url = completionEndpoint || `${baseUrl}/api/v2/chat/completions?chat_id=${chatId}`;
					const res = await fetch(url, {
						method: "POST",
						headers: {
							Accept: "application/json, text/plain, */*",
							"Content-Type": "application/json",
							source: "web",
							version,
							"x-request-id": requestId,
						},
						body: JSON.stringify(requestBody),
						signal: controller.signal,
					});

					const contentType = res.headers.get("content-type") || "";
					if (!res.ok) {
						const errorText = await res.text();
						return {
							ok: false as const,
							status: res.status,
							error: `Qwen HTTP ${res.status} (${contentType || "unknown content-type"}): ${errorText.slice(0, 500)}`,
						};
					}

					const reader = res.body?.getReader();
					if (!reader) return { ok: false as const, status: 500, error: "Qwen response has no body" };

					const decoder = new TextDecoder();
					let fullText = "";
					let bytes = 0;
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						resetIdle();
						if (value) bytes += value.byteLength;
						fullText += decoder.decode(value, { stream: true });
						if (fullText.includes("data: [DONE]")) {
							await reader.cancel().catch(() => {});
							break;
						}
					}
					fullText += decoder.decode();

					if (!fullText.trim()) {
						return {
							ok: false as const,
							status: 502,
							error: `Qwen returned HTTP ${res.status} with ${contentType || "unknown content-type"} but no body bytes`,
						};
					}

					return { ok: true as const, data: fullText, meta: { status: res.status, contentType, bytes } };
				} catch (err) {
					const msg = String(err);
					if (msg.includes("aborted") || msg.includes("AbortError")) {
						return {
							ok: false as const,
							status: 408,
							error: `Qwen stream idle timeout after ${idleTimeoutMs}ms`,
						};
					}
					return { ok: false as const, status: 500, error: msg };
				} finally {
					if (idleTimer) clearTimeout(idleTimer);
				}
			},
			{
				baseUrl: runtime.origin,
				completionEndpoint: runtime.completionEndpoint,
				chatId,
				model: params.model,
				message: params.message,
				fid,
				childId,
				requestId,
				idleTimeoutMs: QWEN_STREAM_IDLE_TIMEOUT_MS,
				version: runtime.version,
			},
		);

		if (responseData.ok && "meta" in responseData) {
			const meta = responseData.meta as { status: number; contentType: string; bytes: number };
			console.log(
				`[QwenWeb] upstream status=${meta.status} contentType=${meta.contentType || "unknown"} bytes=${meta.bytes}`,
			);
		}
		return responseData as EvalResult;
	}

	protected parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return parseQwenStream(body, onDelta);
	}
}
