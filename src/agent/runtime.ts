import type {
	AssistantMessage,
	ChatCompletionRequest,
	ChatMessage,
	ToolMessage,
} from "../openai/types.ts";
import type { HistoryRelation } from "../session/reconciler.ts";
import {
	SessionEventStore,
	type SessionHistorySnapshot,
	type SessionReconciliation,
} from "../session/store.ts";

export type AgentMode = "passthrough" | "optimized";

export interface AgentRuntimeConfig {
	mode: AgentMode;
	sessionIdleTtlSec: number;
	maxToolTurns: number;
	maxIdenticalToolCalls: number;
	toolResultMaxChars: number;
	preserveTailMessages: number;
	telemetry: boolean;
}

export interface AgentSessionSnapshot {
	id: string;
	model: string;
	createdAt: number;
	lastActivityAt: number;
	toolTurns: number;
	rawPromptChars: number;
	optimizedPromptChars: number;
	savedPromptChars: number;
	requests: number;
	canonicalEvents: number;
	historyRelation: HistoryRelation;
	historyEpoch: number;
	historyRevision: number;
	commonPrefixEvents: number;
	deltaEvents: number;
	toolRegistryHash?: string;
	toolRegistryChanged: boolean;
	requiresRehydrate: boolean;
}

export interface AgentOptimizationResult {
	body: ChatCompletionRequest;
	sessionId: string;
	snapshot: AgentSessionSnapshot;
	reconciliation: SessionReconciliation;
	rejection?: { status: number; message: string };
}

type SessionState = AgentSessionSnapshot;

function textOfUserMessage(message: ChatMessage): string {
	if (message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("");
}

function stableHash(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function deriveSessionId(body: ChatCompletionRequest): string {
	if (body.user?.trim()) return `user:${body.user.trim()}`;
	const firstUser = body.messages.find((message) => message.role === "user");
	const firstSystem = body.messages.find(
		(message) => message.role === "system" || message.role === "developer",
	);
	const seed = [
		body.model,
		firstSystem && "content" in firstSystem ? String(firstSystem.content).slice(0, 4000) : "",
		firstUser ? textOfUserMessage(firstUser).slice(0, 4000) : "",
	].join("\n---\n");
	return `auto:${stableHash(seed)}`;
}

function estimateChars(body: ChatCompletionRequest): number {
	try {
		return JSON.stringify({ messages: body.messages, tools: body.tools }).length;
	} catch {
		return 0;
	}
}

function toolCallFingerprints(messages: ChatMessage[]): string[] {
	const out: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const call of (message as AssistantMessage).tool_calls ?? []) {
			out.push(`${call.function.name}:${call.function.arguments}`);
		}
	}
	return out;
}

function maxConsecutiveIdentical(items: string[]): number {
	let max = 0;
	let run = 0;
	let previous: string | undefined;
	for (const item of items) {
		if (item === previous) run += 1;
		else run = 1;
		previous = item;
		max = Math.max(max, run);
	}
	return max;
}

function compactToolResult(content: string, maxChars: number): string {
	if (content.length <= maxChars || maxChars < 256) return content;
	const headSize = Math.floor(maxChars * 0.75);
	const tailSize = Math.max(64, maxChars - headSize);
	const omitted = content.length - headSize - tailSize;
	return [
		content.slice(0, headSize),
		`\n\n[webtoapi context compaction: ${omitted} characters omitted from an older tool result]\n\n`,
		content.slice(-tailSize),
	].join("");
}

function compactHistoricalToolResults(
	messages: ChatMessage[],
	maxChars: number,
	preserveTailMessages: number,
): ChatMessage[] {
	const tailStart = Math.max(0, messages.length - Math.max(1, preserveTailMessages));
	return messages.map((message, index) => {
		if (index >= tailStart || message.role !== "tool") return message;
		const tool = message as ToolMessage;
		return {
			...tool,
			content: compactToolResult(tool.content, maxChars),
		};
	});
}

export class AgentRuntime {
	private readonly sessions = new Map<string, SessionState>();
	private readonly eventStore = new SessionEventStore();
	private config: AgentRuntimeConfig;

	constructor(config: AgentRuntimeConfig) {
		this.config = config;
	}

	configure(config: AgentRuntimeConfig): void {
		this.config = config;
	}

	optimize(body: ChatCompletionRequest): AgentOptimizationResult {
		this.cleanupExpired();
		const sessionId = deriveSessionId(body);
		const now = Date.now();
		const reconciliation = this.eventStore.reconcile(
			sessionId,
			body.messages,
			body.tools,
			now,
		);
		const rawChars = estimateChars(body);
		const fingerprints = toolCallFingerprints(body.messages);
		const toolTurns = body.messages.filter(
			(message) =>
				message.role === "assistant" && ((message as AssistantMessage).tool_calls?.length ?? 0) > 0,
		).length;

		let optimizedBody = body;
		if (this.config.mode === "optimized") {
			optimizedBody = {
				...body,
				messages: compactHistoricalToolResults(
					body.messages,
					this.config.toolResultMaxChars,
					this.config.preserveTailMessages,
				),
			};
		}
		const optimizedChars = estimateChars(optimizedBody);

		const existing = this.sessions.get(sessionId);
		const snapshot: SessionState = existing ?? {
			id: sessionId,
			model: body.model,
			createdAt: now,
			lastActivityAt: now,
			toolTurns: 0,
			rawPromptChars: 0,
			optimizedPromptChars: 0,
			savedPromptChars: 0,
			requests: 0,
			canonicalEvents: 0,
			historyRelation: "initial",
			historyEpoch: 1,
			historyRevision: 0,
			commonPrefixEvents: 0,
			deltaEvents: 0,
			toolRegistryChanged: false,
			requiresRehydrate: false,
		};
		snapshot.lastActivityAt = now;
		snapshot.model = body.model;
		snapshot.toolTurns = toolTurns;
		snapshot.rawPromptChars += rawChars;
		snapshot.optimizedPromptChars += optimizedChars;
		snapshot.savedPromptChars += Math.max(0, rawChars - optimizedChars);
		snapshot.requests += 1;
		snapshot.canonicalEvents = reconciliation.incomingEvents;
		snapshot.historyRelation = reconciliation.relation;
		snapshot.historyEpoch = reconciliation.epoch;
		snapshot.historyRevision = reconciliation.revision;
		snapshot.commonPrefixEvents = reconciliation.commonPrefixEvents;
		snapshot.deltaEvents = reconciliation.deltaEvents.length;
		snapshot.toolRegistryHash = reconciliation.toolRegistry?.hash;
		snapshot.toolRegistryChanged = reconciliation.toolRegistryChanged;
		snapshot.requiresRehydrate = reconciliation.requiresRehydrate;
		this.sessions.set(sessionId, snapshot);

		if (this.config.mode === "optimized" && toolTurns > this.config.maxToolTurns) {
			return {
				body: optimizedBody,
				sessionId,
				snapshot: { ...snapshot },
				reconciliation,
				rejection: {
					status: 409,
					message: `Agent loop guard: session exceeded maxToolTurns=${this.config.maxToolTurns}.`,
				},
			};
		}

		const repeated = maxConsecutiveIdentical(fingerprints);
		if (this.config.mode === "optimized" && repeated > this.config.maxIdenticalToolCalls) {
			return {
				body: optimizedBody,
				sessionId,
				snapshot: { ...snapshot },
				reconciliation,
				rejection: {
					status: 409,
					message: `Agent loop guard: identical tool call repeated ${repeated} times.`,
				},
			};
		}

		if (this.config.telemetry) {
			const saved = Math.max(0, rawChars - optimizedChars);
			console.log(
				`[agent] session=${sessionId} model=${body.model} request=${snapshot.requests} toolTurns=${toolTurns} rawChars=${rawChars} optimizedChars=${optimizedChars} savedChars=${saved} history=${reconciliation.relation} prefixEvents=${reconciliation.commonPrefixEvents} deltaEvents=${reconciliation.deltaEvents.length} epoch=${reconciliation.epoch} rehydrate=${reconciliation.requiresRehydrate} toolsChanged=${reconciliation.toolRegistryChanged}`,
			);
		}

		return {
			body: optimizedBody,
			sessionId,
			snapshot: { ...snapshot },
			reconciliation,
		};
	}

	getSnapshot(sessionId: string): AgentSessionSnapshot | undefined {
		const state = this.sessions.get(sessionId);
		return state ? { ...state } : undefined;
	}

	getHistorySnapshot(sessionId: string): SessionHistorySnapshot | undefined {
		return this.eventStore.get(sessionId);
	}

	listSnapshots(): AgentSessionSnapshot[] {
		this.cleanupExpired();
		return [...this.sessions.values()].map((state) => ({ ...state }));
	}

	private cleanupExpired(): void {
		const ttlMs = Math.max(60, this.config.sessionIdleTtlSec) * 1000;
		const cutoff = Date.now() - ttlMs;
		for (const [id, state] of this.sessions) {
			if (state.lastActivityAt < cutoff) this.sessions.delete(id);
		}
		this.eventStore.cleanupBefore(cutoff);
	}
}

export const agentRuntime = new AgentRuntime({
	mode: "optimized",
	sessionIdleTtlSec: 3600,
	maxToolTurns: 40,
	maxIdenticalToolCalls: 2,
	toolResultMaxChars: 12_000,
	preserveTailMessages: 6,
	telemetry: true,
});
