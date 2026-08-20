import type { Page } from "playwright-core";
import { textToStream } from "../shared/stream-helpers.ts";
import type { ProviderSendParams } from "../types.ts";
import { ProviderApiError, SessionExpiredError, withTimeout } from "../types.ts";
import type { ClaudeWebAuth } from "./auth.ts";
import { ClaudeWebClient } from "./client.ts";

const ROOT_MESSAGE_UUID = "00000000-0000-4000-8000-000000000000";
const SEND_TIMEOUT_MS = 120_000;

type StatefulClaudeResult =
	| {
			ok: true;
			data: string;
			conversationUuid: string;
			parentMessageUuid: string;
	  }
	| {
			ok: false;
			status: number;
			error: string;
	  };

/**
 * Adds safe upstream conversation affinity to Claude Web while preserving the
 * legacy stateless/DOM behavior for requests that do not opt into a stable
 * gateway session.
 *
 * Stateful requests never fall back to the shared Claude DOM page. A 403 is
 * failed closed so a delta prompt cannot land in an unrelated visual thread.
 */
export class ClaudeStatefulWebClient extends ClaudeWebClient {
	private statefulOrganizationId: string | undefined;
	private conversationUuid: string | undefined;
	private parentMessageUuid: string | undefined;

	constructor(auth: ClaudeWebAuth) {
		super(auth);
	}

	override async sendMessage(params: ProviderSendParams): Promise<ReadableStream<Uint8Array>> {
		if (!params.statefulSession) return super.sendMessage(params);
		if (!params.sessionId) {
			throw new Error("Claude stateful request requires a stable gateway session id");
		}

		if (params.resetSession) this.resetStatefulConversation();

		try {
			return await this.sendStatefulMessage(params);
		} catch (err) {
			if (err instanceof SessionExpiredError) {
				console.warn("[ClaudeWeb] Stateful session expired, attempting auto-refresh...");
				const refreshed = await this.refreshSession();
				if (refreshed) {
					this.statefulOrganizationId = undefined;
					this.resetStatefulConversation();
					return this.sendStatefulMessage({
						...params,
						message: params.rehydrationMessage ?? params.message,
						resetSession: true,
					});
				}
			}
			throw err;
		}
	}

	override async close(): Promise<void> {
		this.resetStatefulConversation();
		this.statefulOrganizationId = undefined;
		await super.close();
	}

	private resetStatefulConversation(): void {
		this.conversationUuid = undefined;
		this.parentMessageUuid = undefined;
	}

	private async resolveOrganizationId(page: Page): Promise<string> {
		if (this.statefulOrganizationId) return this.statefulOrganizationId;
		const result = await page.evaluate(async () => {
			const res = await fetch("https://claude.ai/api/organizations", {
				credentials: "include",
			});
			if (!res.ok) return { ok: false as const, status: res.status };
			const orgs = (await res.json()) as Array<{ uuid?: string }>;
			const uuid = orgs[0]?.uuid;
			return uuid
				? { ok: true as const, uuid }
				: { ok: false as const, status: 500 };
		});
		if (!result.ok) {
			if (result.status === 401) throw new SessionExpiredError(this.providerId);
			throw new ProviderApiError(
				result.status,
				`Claude organization discovery failed with HTTP ${result.status}`,
			);
		}
		this.statefulOrganizationId = result.uuid;
		return result.uuid;
	}

	private async sendStatefulMessage(
		params: ProviderSendParams,
	): Promise<ReadableStream<Uint8Array>> {
		const page = await this.getPage();
		const organizationId = await this.resolveOrganizationId(page);
		const requestedConversationUuid = this.conversationUuid ?? crypto.randomUUID();
		const parentMessageUuid = this.parentMessageUuid ?? ROOT_MESSAGE_UUID;
		const model = params.model || this.config.defaultModel;
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const shouldCreateConversation = !this.conversationUuid;

		const result = (await withTimeout(
			page.evaluate(
				async ({
					organizationId: orgId,
					conversationUuid: requestedUuid,
					parentMessageUuid: parentUuid,
					model: selectedModel,
					timezone: tz,
					message,
					shouldCreateConversation: createConversation,
				}) => {
					const apiBase = `https://claude.ai/api/organizations/${orgId}`;
					let conversationUuid = requestedUuid;

					if (createConversation) {
						const createRes = await fetch(`${apiBase}/chat_conversations`, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							credentials: "include",
							body: JSON.stringify({ name: "", uuid: requestedUuid }),
						});
						if (!createRes.ok) {
							return {
								ok: false as const,
								status: createRes.status,
								error: `[create_conversation] ${createRes.status} ${(await createRes.text()).slice(0, 500)}`,
							};
						}
						const created = (await createRes.json()) as { uuid?: string };
						conversationUuid = created.uuid ?? requestedUuid;
					}

					const completionRes = await fetch(
						`${apiBase}/chat_conversations/${conversationUuid}/completion`,
						{
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								Accept: "text/event-stream",
							},
							credentials: "include",
							body: JSON.stringify({
								prompt: message,
								parent_message_uuid: parentUuid,
								model: selectedModel,
								timezone: tz,
								rendering_mode: "messages",
								attachments: [],
								files: [],
								locale: "en-US",
								personalized_styles: [],
								sync_sources: [],
								tools: [],
							}),
						},
					);
					if (!completionRes.ok) {
						return {
							ok: false as const,
							status: completionRes.status,
							error: `[completion] ${completionRes.status} ${(await completionRes.text()).slice(0, 500)}`,
						};
					}

					const reader = completionRes.body?.getReader();
					if (!reader) {
						return { ok: false as const, status: 500, error: "No response body from Claude API" };
					}
					const decoder = new TextDecoder();
					let fullText = "";
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						fullText += decoder.decode(value, { stream: true });
					}

					const stateRes = await fetch(
						`${apiBase}/chat_conversations/${conversationUuid}?tree=true&rendering_mode=messages&render_all_tools=true&consistency=strong`,
						{ credentials: "include" },
					);
					if (!stateRes.ok) {
						return {
							ok: false as const,
							status: stateRes.status,
							error: `[conversation_state] ${stateRes.status} ${(await stateRes.text()).slice(0, 500)}`,
						};
					}
					const state = (await stateRes.json()) as { current_leaf_message_uuid?: string };
					if (!state.current_leaf_message_uuid) {
						return {
							ok: false as const,
							status: 502,
							error: "Claude conversation state did not include current_leaf_message_uuid",
						};
					}

					return {
						ok: true as const,
						data: fullText,
						conversationUuid,
						parentMessageUuid: state.current_leaf_message_uuid,
					};
				},
				{
					organizationId,
					conversationUuid: requestedConversationUuid,
					parentMessageUuid,
					model,
					timezone,
					message: params.message,
					shouldCreateConversation,
				},
			),
			SEND_TIMEOUT_MS,
			"Claude stateful request",
		)) as StatefulClaudeResult;

		if (!result.ok) {
			if (result.status === 401) throw new SessionExpiredError(this.providerId, result.error);
			if (result.status === 403) {
				throw new ProviderApiError(
					403,
					`Claude stateful request was rejected with HTTP 403; refusing shared DOM fallback: ${result.error}`,
				);
			}
			if (result.status === 429) {
				throw new ProviderApiError(429, `Claude rate limit reached: ${result.error}`);
			}
			this.resetStatefulConversation();
			throw new ProviderApiError(
				result.status >= 400 && result.status < 600 ? result.status : 502,
				result.error,
			);
		}

		this.conversationUuid = result.conversationUuid;
		this.parentMessageUuid = result.parentMessageUuid;
		console.log(
			`[ClaudeWeb] Stateful conversation=${this.conversationUuid} parent=${this.parentMessageUuid}`,
		);
		return textToStream(result.data);
	}
}
