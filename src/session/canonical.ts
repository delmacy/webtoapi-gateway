import { createHash } from "node:crypto";
import type {
	AssistantMessage,
	ChatMessage,
	ContentPart,
	ToolDefinition,
	ToolMessage,
} from "../openai/types.ts";

export type CanonicalEventKind =
	| "system_instruction"
	| "developer_instruction"
	| "user_message"
	| "assistant_message"
	| "tool_call"
	| "tool_result";

export interface CanonicalEvent {
	seq: number;
	id: string;
	kind: CanonicalEventKind;
	hash: string;
	sourceMessageIndex: number;
	payload: Record<string, unknown>;
}

export interface ToolRegistrySnapshot {
	hash: string;
	count: number;
	names: string[];
}

type LegacyFunctionMessage = {
	role: "function";
	name?: string;
	content: string;
};

function normalizeJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeJson);
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const normalized: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) normalized[key] = normalizeJson(record[key]);
		return normalized;
	}
	return value;
}

export function stableJson(value: unknown): string {
	return JSON.stringify(normalizeJson(value)) ?? "null";
}

export function semanticHash(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

function normalizedContentParts(parts: ContentPart[]): Array<Record<string, unknown>> {
	return parts.map((part) => {
		if (part.type === "text") return { type: "text", text: part.text ?? "" };
		return {
			type: "image_url",
			url: part.image_url?.url ?? "",
			detail: part.image_url?.detail ?? undefined,
		};
	});
}

function userPayload(message: Extract<ChatMessage, { role: "user" }>): Record<string, unknown> {
	if (typeof message.content === "string") return { content: message.content };
	return { content: normalizedContentParts(message.content) };
}

function parseArguments(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return { _raw: raw };
	}
}

function makeEvent(
	seq: number,
	kind: CanonicalEventKind,
	sourceMessageIndex: number,
	payload: Record<string, unknown>,
): CanonicalEvent {
	const hash = semanticHash({ kind, payload });
	return {
		seq,
		id: `evt_${String(seq).padStart(6, "0")}_${hash.slice(0, 16)}`,
		kind,
		hash,
		sourceMessageIndex,
		payload,
	};
}

export function normalizeOpenAiMessages(messages: ChatMessage[]): CanonicalEvent[] {
	const events: CanonicalEvent[] = [];
	const push = (
		kind: CanonicalEventKind,
		sourceMessageIndex: number,
		payload: Record<string, unknown>,
	) => {
		events.push(makeEvent(events.length, kind, sourceMessageIndex, payload));
	};

	messages.forEach((message, sourceMessageIndex) => {
		const legacy = message as unknown as Partial<LegacyFunctionMessage>;
		if (legacy.role === "function" && typeof legacy.content === "string") {
			push("tool_result", sourceMessageIndex, {
				callId: legacy.name ?? "unknown",
				content: legacy.content,
				legacy: true,
			});
			return;
		}

		switch (message.role) {
			case "system":
				push("system_instruction", sourceMessageIndex, { content: message.content });
				break;
			case "developer":
				push("developer_instruction", sourceMessageIndex, { content: message.content });
				break;
			case "user":
				push("user_message", sourceMessageIndex, userPayload(message));
				break;
			case "assistant": {
				const assistant = message as AssistantMessage;
				if (typeof assistant.content === "string" && assistant.content.length > 0) {
					push("assistant_message", sourceMessageIndex, { content: assistant.content });
				}
				for (const call of assistant.tool_calls ?? []) {
					push("tool_call", sourceMessageIndex, {
						callId: call.id,
						name: call.function.name,
						arguments: parseArguments(call.function.arguments),
					});
				}
				break;
			}
			case "tool": {
				const tool = message as ToolMessage;
				push("tool_result", sourceMessageIndex, {
					callId: tool.tool_call_id,
					content: tool.content,
				});
				break;
			}
		}
	});

	return events;
}

export function snapshotToolRegistry(tools?: ToolDefinition[]): ToolRegistrySnapshot | undefined {
	if (!tools || tools.length === 0) return undefined;
	const canonical = tools
		.map((tool) => ({
			type: tool.type,
			name: tool.function.name,
			description: tool.function.description ?? "",
			parameters: tool.function.parameters ?? {},
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
	return {
		hash: semanticHash(canonical),
		count: canonical.length,
		names: canonical.map((tool) => tool.name),
	};
}
