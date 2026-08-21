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
const QWEN_EVALUATE_TIMEOUT_MS = 60_000;
const QWEN_HISTORY_POLL_ATTEMPTS = 12;
const QWEN_HISTORY_POLL_INTERVAL_MS = 250;

type QwenErrorResult = {
	ok: false;
	status: number;
	error: string;
	stage?: string;
};

type QwenCreateSuccess = {
	ok: true;
	chatId: string;
};

type QwenCompletionSuccess = {
	ok: true;
	data: string;
	assistantMessageId?: string;
	meta?: { status: number; contentType: string; bytes: number; firstByte: boolean };
};

type QwenCreateResult = QwenCreateSuccess | QwenErrorResult;
type QwenCompletionResult = QwenCompletionSuccess | QwenErrorResult;

function timeoutResult(stage: string, timeoutMs: number): Promise<QwenErrorResult> {
	return new Promise((resolve) => {
		setTimeout(
			() =>
				resolve({
					ok: false,
					status: 408,
					error: `Qwen ${stage} timed out after ${timeoutMs}ms`,
					stage,
				}),
			timeoutMs,
		);
	});
}

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

	private chatId = "";
	private parentMessageId: string | null = null;

	protected getCookies() {
		return parseCookieHeader(
			this.auth.cookie || `qwen_session=${this.auth.sessionToken}`,
			this.config.cookieDomain,
		);
	}

	private getRuntimeTarget(chatId?: string): {
		origin: string;
		completionEndpoint?: string;
		version: string;
	} {
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

	private async createChat(page: Page, model: string): Promise<QwenCreateResult> {
		const runtime = this.getRuntimeTarget();
		const requestId = crypto.randomUUID();
		console.log(
			`[QwenWeb] stage=create-chat:start model=${model} origin=${runtime.origin} version=${runtime.version}`,
		);

		const createEval = page.evaluate(
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
					if (!res.ok) return { ok: false as const, status: res.status, error: await res.text() };
					const data = await res.json();
					const chatId = data.data?.id ?? data.chat_id ?? data.id ?? data.chatId;
					if (!chatId) {
						return {
							ok: false as const,
							status: 502,
							error: `Qwen create-chat returned no chat id: ${JSON.stringify(data).slice(0, 400)}`,
						};
					}
					return { ok: true as const, chatId: String(chatId) };
				} catch (err) {
					const msg = String(err);
					return {
						ok: false as const,
						status: msg.includes("aborted") || msg.includes("AbortError") ? 408 : 500,
						error:
							msg.includes("aborted") || msg.includes("AbortError")
								? `Create chat timed out after ${timeoutMs}ms`
								: msg,
					};
				} finally {
					clearTimeout(timer);
				}
			},
			{
				baseUrl: runtime.origin,
				timeoutMs: QWEN_CREATE_TIMEOUT_MS,
				model,
				requestId,
				version: runtime.version,
			},
		);

		const result = (await Promise.race([
			createEval,
			timeoutResult("create-chat browser evaluation", QWEN_EVALUATE_TIMEOUT_MS),
		])) as QwenCreateResult;
		if (result.ok) console.log(`[QwenWeb] stage=create-chat:ok chatId=${result.chatId}`);
		else
			console.warn(
				`[QwenWeb] stage=create-chat:error status=${result.status} error=${result.error}`,
			);
		return result;
	}

	protected async callApi(page: Page, params: NormalizedSendParams): Promise<EvalResult> {
		const stateful = Boolean(params.sessionId?.trim());
		let chatId = stateful ? this.chatId : "";
		let parentMessageId = stateful ? this.parentMessageId : null;

		if (!chatId) {
			const created = await this.createChat(page, params.model);
			if (!created.ok) return created;
			chatId = created.chatId;
			parentMessageId = null;
			if (stateful) {
				this.chatId = chatId;
				this.parentMessageId = null;
			}
		} else {
			console.log(
				`[QwenWeb] stage=reuse-chat chatId=${chatId} parentId=${parentMessageId ?? "null"}`,
			);
		}

		const runtime = this.getRuntimeTarget(chatId);
		const fid = crypto.randomUUID();
		const childId = crypto.randomUUID();
		const requestId = crypto.randomUUID();
		console.log(
			`[QwenWeb] stage=completion:start endpoint=${runtime.completionEndpoint ?? `${runtime.origin}/api/v2/chat/completions`} model=${params.model}`,
		);

		const completionEval = page.evaluate(
			async ({
				baseUrl,
				completionEndpoint,
				chatId,
				model,
				message,
				fid,
				childId,
				parentMessageId,
				requestId,
				idleTimeoutMs,
				version,
				historyPollAttempts,
				historyPollIntervalMs,
				trackParent,
			}) => {
				const requestBody = {
					stream: true,
					version: "2.1",
					incremental_output: true,
					chat_id: chatId,
					chat_mode: "normal",
					model,
					parent_id: parentMessageId,
					messages: [
						{
							id: null,
							fid,
							parentId: parentMessageId,
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
							parent_id: parentMessageId,
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
							stage: "headers" as const,
						};
					}

					const reader = res.body?.getReader();
					if (!reader) {
						return {
							ok: false as const,
							status: 500,
							error: "Qwen response has no body",
							stage: "headers" as const,
						};
					}

					const decoder = new TextDecoder();
					let fullText = "";
					let bytes = 0;
					let firstByteAt: number | undefined;
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						resetIdle();
						if (value) {
							bytes += value.byteLength;
							if (!firstByteAt && value.byteLength > 0) firstByteAt = Date.now();
						}
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
							stage: firstByteAt ? ("body" as const) : ("first-byte" as const),
						};
					}

					let assistantMessageId: string | undefined;
					if (trackParent) {
						for (let attempt = 0; attempt < historyPollAttempts; attempt++) {
							if (attempt > 0) {
								await new Promise((resolve) => setTimeout(resolve, historyPollIntervalMs));
							}
							const historyRes = await fetch(`${baseUrl}/api/v2/chats/${chatId}/`, {
								headers: {
									Accept: "application/json, text/plain, */*",
									source: "web",
									version,
									"x-request-id": crypto.randomUUID(),
								},
							});
							if (!historyRes.ok) continue;
							const detail = await historyRes.json();
							const messages = detail?.data?.chat?.history?.messages;
							if (!messages || typeof messages !== "object") continue;
							const entries = Object.entries(messages) as Array<
								[string, { id?: unknown; role?: unknown }]
							>;
							for (let index = entries.length - 1; index >= 0; index--) {
								const [key, item] = entries[index] ?? [];
								if (!item || item.role !== "assistant") continue;
								const candidate = typeof item.id === "string" ? item.id : key;
								if (candidate && candidate !== parentMessageId) {
									assistantMessageId = candidate;
									break;
								}
							}
							if (assistantMessageId) break;
						}
						if (!assistantMessageId) {
							return {
								ok: false as const,
								status: 502,
								error: `Qwen chat ${chatId} completed but no new assistant message id appeared in history`,
								stage: "history" as const,
							};
						}
					}

					return {
						ok: true as const,
						data: fullText,
						assistantMessageId,
						meta: { status: res.status, contentType, bytes, firstByte: Boolean(firstByteAt) },
					};
				} catch (err) {
					const msg = String(err);
					if (msg.includes("aborted") || msg.includes("AbortError")) {
						return {
							ok: false as const,
							status: 408,
							error: `Qwen completion/stream idle timeout after ${idleTimeoutMs}ms`,
							stage: "completion-or-first-byte" as const,
						};
					}
					return { ok: false as const, status: 500, error: msg, stage: "completion" as const };
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
				parentMessageId,
				requestId,
				idleTimeoutMs: QWEN_STREAM_IDLE_TIMEOUT_MS,
				version: runtime.version,
				historyPollAttempts: QWEN_HISTORY_POLL_ATTEMPTS,
				historyPollIntervalMs: QWEN_HISTORY_POLL_INTERVAL_MS,
				trackParent: stateful,
			},
		);

		const responseData = (await Promise.race([
			completionEval,
			timeoutResult("completion browser evaluation", QWEN_EVALUATE_TIMEOUT_MS),
		])) as QwenCompletionResult;

		if (responseData.ok) {
			if (stateful) {
				if (!responseData.assistantMessageId) {
					return {
						ok: false,
						status: 502,
						error: `Qwen stateful chat ${chatId} returned no assistant message id`,
					};
				}
				this.chatId = chatId;
				this.parentMessageId = responseData.assistantMessageId;
				console.log(
					`[QwenWeb] stage=state:updated chatId=${chatId} parentId=${this.parentMessageId}`,
				);
			}
			if (responseData.meta) {
				console.log(
					`[QwenWeb] stage=completion:ok status=${responseData.meta.status} contentType=${responseData.meta.contentType || "unknown"} bytes=${responseData.meta.bytes} firstByte=${responseData.meta.firstByte}`,
				);
			}
			return { ok: true, data: responseData.data };
		}

		console.warn(
			`[QwenWeb] stage=${responseData.stage ?? "completion"}:error status=${responseData.status} error=${responseData.error}`,
		);
		return responseData;
	}

	protected parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return parseQwenStream(body, onDelta);
	}
}
