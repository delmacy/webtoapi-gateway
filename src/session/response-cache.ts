import type { ChatCompletionRequest, ToolCallOutput } from "../openai/types.ts";
import { normalizeOpenAiMessages, semanticHash, snapshotToolRegistry } from "./canonical.ts";

export interface CachedAgentResponse {
	content: string | null;
	toolCalls: ToolCallOutput[] | undefined;
	finishReason: "stop" | "tool_calls";
	rawText: string;
	promptText: string;
	createdAt: number;
}

type CacheEntry = CachedAgentResponse & {
	key: string;
	lastAccessAt: number;
};

function cloneToolCalls(toolCalls: ToolCallOutput[] | undefined): ToolCallOutput[] | undefined {
	return toolCalls?.map((call) => ({
		...call,
		function: { ...call.function },
	}));
}

function cloneResponse(entry: CachedAgentResponse): CachedAgentResponse {
	return {
		...entry,
		toolCalls: cloneToolCalls(entry.toolCalls),
	};
}

export function fingerprintChatRequest(body: ChatCompletionRequest): string {
	const events = normalizeOpenAiMessages(body.messages);
	const tools = snapshotToolRegistry(body.tools);
	return semanticHash({
		model: body.model,
		events: events.map((event) => event.hash),
		toolRegistry: tools?.hash ?? null,
		toolChoice: body.tool_choice ?? null,
		temperature: body.temperature ?? null,
		maxTokens: body.max_tokens ?? null,
	});
}

export class AgentResponseCache {
	private readonly entries = new Map<string, CacheEntry>();

	constructor(
		private readonly maxEntries = 256,
		private readonly ttlMs = 60 * 60 * 1000,
	) {}

	private makeKey(providerId: string, sessionId: string, requestFingerprint: string): string {
		return `${providerId}\n${sessionId}\n${requestFingerprint}`;
	}

	get(
		providerId: string,
		sessionId: string,
		requestFingerprint: string,
		now = Date.now(),
	): CachedAgentResponse | undefined {
		this.cleanup(now);
		const key = this.makeKey(providerId, sessionId, requestFingerprint);
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		entry.lastAccessAt = now;
		return cloneResponse(entry);
	}

	set(
		providerId: string,
		sessionId: string,
		requestFingerprint: string,
		response: Omit<CachedAgentResponse, "createdAt">,
		now = Date.now(),
	): void {
		this.cleanup(now);
		const key = this.makeKey(providerId, sessionId, requestFingerprint);
		this.entries.set(key, {
			...cloneResponse({ ...response, createdAt: now }),
			key,
			lastAccessAt: now,
		});
		this.enforceLimit();
	}

	deleteSession(providerId: string, sessionId: string): number {
		const prefix = `${providerId}\n${sessionId}\n`;
		let deleted = 0;
		for (const key of this.entries.keys()) {
			if (key.startsWith(prefix)) {
				this.entries.delete(key);
				deleted += 1;
			}
		}
		return deleted;
	}

	private cleanup(now: number): void {
		const cutoff = now - this.ttlMs;
		for (const [key, entry] of this.entries) {
			if (entry.createdAt < cutoff) this.entries.delete(key);
		}
	}

	private enforceLimit(): void {
		if (this.entries.size <= this.maxEntries) return;
		const ordered = [...this.entries.values()].sort((a, b) => a.lastAccessAt - b.lastAccessAt);
		for (const entry of ordered.slice(0, this.entries.size - this.maxEntries)) {
			this.entries.delete(entry.key);
		}
	}
}

export const agentResponseCache = new AgentResponseCache();
