import type {
	AssistantMessage,
	ChatCompletionRequest,
	ChatMessage,
	ToolMessage,
} from "../openai/types.ts";

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
}

export interface AgentOptimizationResult {
	body: ChatCompletionRequest;
	sessionId: string;
	snapshot: AgentSessionSnapshot;
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
		};
		snapshot.lastActivityAt = now;
		snapshot.model = body.model;
		snapshot.toolTurns = toolTurns;
		snapshot.rawPromptChars += rawChars;
		snapshot.optimizedPromptChars += optimizedChars;
		snapshot.savedPromptChars += Math.max(0, rawChars - optimizedChars);
		snapshot.requests += 1;
		this.sessions.set(sessionId, snapshot);

		if (this.config.mode === "optimized" && toolTurns > this.config.maxToolTurns) {
			return {
				body: optimizedBody,
				sessionId,
				snapshot: { ...snapshot },
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
				rejection: {
					status: 409,
					message: `Agent loop guard: identical tool call repeated ${repeated} times.`,
				},
			};
		}

		if (this.config.telemetry) {
			const saved = Math.max(0, rawChars - optimizedChars);
			console.log(
				`[agent] session=${sessionId} model=${body.model} request=${snapshot.requests} toolTurns=${toolTurns} rawChars=${rawChars} optimizedChars=${optimizedChars} savedChars=${saved}`,
			);
		}

		return { body: optimizedBody, sessionId, snapshot: { ...snapshot } };
	}

	getSnapshot(sessionId: string): AgentSessionSnapshot | undefined {
		const state = this.sessions.get(sessionId);
		return state ? { ...state } : undefined;
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
