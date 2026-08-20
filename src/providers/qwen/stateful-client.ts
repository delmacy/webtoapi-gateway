import crypto from "node:crypto";
import type { Page } from "playwright-core";
import type { NormalizedSendParams } from "../factory/types.ts";
import { runtimeProfiles } from "../runtime-profile.ts";
import type { EvalResult } from "../shared/eval-helpers.ts";
import { QwenWebClient } from "./client.ts";

const QWEN_WEB_VERSION = "0.2.83";
const QWEN_FALLBACK_ORIGIN = "https://chat.qwen.ai";
const QWEN_CREATE_TIMEOUT_MS = 30_000;
const QWEN_STREAM_IDLE_TIMEOUT_MS = 45_000;
const QWEN_EVALUATE_TIMEOUT_MS = 60_000;

type QwenStatefulResult =
	| {
			ok: true;
			data: string;
			chatId: string;
			parentId: string;
	  }
	| {
			ok: false;
			status: number;
			error: string;
			stage?: string;
	  };

function timeoutResult(stage: string, timeoutMs: number): Promise<QwenStatefulResult> {
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

/**
 * Reuses Qwen's upstream chat_id + response parent_id for explicit stable
 * gateway sessions. Stateless calls continue through the legacy client.
 */
export class QwenStatefulWebClient extends QwenWebClient {
	private chatId: string | undefined;
	private parentId: string | undefined;

	override async close(): Promise<void> {
		this.resetStatefulConversation();
		await super.close();
	}

	protected override async callApi(page: Page, params: NormalizedSendParams): Promise<EvalResult> {
		if (!params.statefulSession) return super.callApi(page, params);
		if (!params.sessionId) {
			return { ok: false, status: 400, error: "Qwen stateful request requires a stable session id" };
		}
		if (params.resetSession) this.resetStatefulConversation();

		const result = await this.callStatefulApi(page, params);
		if (!result.ok) {
			this.resetStatefulConversation();
			return result;
		}

		this.chatId = result.chatId;
		this.parentId = result.parentId;
		console.log(`[QwenWeb] Stateful chatId=${this.chatId} parentId=${this.parentId}`);
		return { ok: true, data: result.data };
	}

	private resetStatefulConversation(): void {
		this.chatId = undefined;
		this.parentId = undefined;
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

	private async createChat(page: Page, model: string): Promise<string | QwenStatefulResult> {
		if (this.chatId) return this.chatId;
		const runtime = this.getRuntimeTarget();
		const requestId = crypto.randomUUID();
		const createEval = page.evaluate(
			async ({ baseUrl, timeoutMs, model: selectedModel, requestId: reqId, version }) => {
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
							"x-request-id": reqId,
						},
						body: JSON.stringify({
							title: "New Chat",
							models: [selectedModel],
							chat_mode: "normal",
							chat_type: "t2t",
							timestamp: Date.now(),
							project_id: "",
						}),
						credentials: "include",
						 signal: controller.signal,
					});
					if (!res.ok) {
						return { ok: false as const, status: res.status, error: await res.text(), stage: "create-chat" };
					}
					const data = await res.json();
					const chatId = data.data?.id ?? data.chat_id ?? data.id ?? data.chatId;
					return chatId
						? { ok: true as const, chatId: String(chatId) }
						: {
								ok: false as const,
								status: 502,
								error: `Qwen create-chat returned no chat id: ${JSON.stringify(data).slice(0, 400)}`,
								stage: "create-chat",
							};
				} catch (err) {
					return {
						ok: false as const,
						status: 500,
						error: String(err),
						stage: "create-chat",
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
		])) as { ok: true; chatId: string } | QwenStatefulResult;
		return result.ok ? result.chatId : result;
	}

	private async callStatefulApi(
		page: Page,
		params: NormalizedSendParams,
	): Promise<QwenStatefulResult> {
		const model = params.model;
		const chat = await this.createChat(page, model);
		if (typeof chat !== "string") return chat;

		const runtime = this.getRuntimeTarget(chat);
		const parentId = this.parentId ?? null;
		const fid = crypto.randomUUID();
		const childId = crypto.randomUUID();
		const requestId = crypto.randomUUID();
		const completionEval = page.evaluate(
			async ({
				baseUrl,
				completionEndpoint,
				chatId,
				model: selectedModel,
				message,
				parentId,
				fid,
				childId,
				requestId: reqId,
				idleTimeoutMs,
				version,
			}) => {
				const requestBody = {
					stream: true,
					version: "2.1",
					incremental_output: true,
					chat_id: chatId,
					chat_mode: "normal",
					model: selectedModel,
					parent_id: parentId,
					messages: [
						{
							id: null,
							fid,
							parentId,
							childrenIds: [childId],
							role: "user",
							content: message,
							user_action: "chat",
							files: [],
							timestamp: Date.now(),
							models: [selectedModel],
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
							parent_id: parentId,
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
							"x-request-id": reqId,
						},
						body: JSON.stringify(requestBody),
						credentials: "include",
						signal: controller.signal,
					});
					if (!res.ok) {
						return {
							ok: false as const,
							status: res.status,
							error: `Qwen HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`,
							stage: "completion",
						};
					}

					const reader = res.body?.getReader();
					if (!reader) {
						return { ok: false as const, status: 500, error: "Qwen response has no body", stage: "completion" };
					}
					const decoder = new TextDecoder();
					let fullText = "";
					let nextParentId: string | undefined;
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						resetIdle();
						fullText += decoder.decode(value, { stream: true });
						const lines = fullText.split("\n");
						for (const line of lines) {
							if (!line.startsWith("data:")) continue;
							const raw = line.slice(5).trim();
							if (!raw || raw === "[DONE]") continue;
							try {
								const event = JSON.parse(raw) as Record<string, unknown>;
								const created = event["response.created"] as { response_id?: string } | undefined;
								if (created?.response_id) nextParentId = created.response_id;
							} catch {
								// partial lines are retried after more bytes arrive
							}
						}
						if (fullText.includes("data: [DONE]")) {
							await reader.cancel().catch(() => {});
							break;
						}
					}
					fullText += decoder.decode();
					if (!nextParentId) {
						return {
							ok: false as const,
							status: 502,
							error: "Qwen stateful response did not expose response.created.response_id",
							stage: "parent-id",
						};
					}
					return { ok: true as const, data: fullText, chatId, parentId: nextParentId };
				} catch (err) {
					return {
						ok: false as const,
						status: 500,
						error: String(err),
						stage: "completion",
					};
				} finally {
					if (idleTimer) clearTimeout(idleTimer);
				}
			},
			{
				baseUrl: runtime.origin,
				completionEndpoint: runtime.completionEndpoint,
				chatId: chat,
				model,
				message: params.message,
				parentId,
				fid,
				childId,
				requestId,
				idleTimeoutMs: QWEN_STREAM_IDLE_TIMEOUT_MS,
				version: runtime.version,
			},
		);

		return (await Promise.race([
			completionEval,
			timeoutResult("completion browser evaluation", QWEN_EVALUATE_TIMEOUT_MS),
		])) as QwenStatefulResult;
	}
}
