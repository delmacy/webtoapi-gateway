/**
 * Converts between OpenAI tool protocol and text-based tool calling.
 *
 * Flow:
 * 1. buildPromptFromMessages: Converts OpenAI tools + messages into a single prompt
 * 2. parseToolResponse: Parses the model text response into OpenAI tool_calls format
 * 3. tool_choice handling is preserved before prompt generation
 */

import type {
	AssistantMessage,
	ChatMessage,
	ToolCallOutput,
	ToolChoice,
	ToolDefinition,
	ToolMessage,
} from "../openai/types.ts";
import { normalizeRawProtocolResponse } from "../protocol/raw-normalizer.ts";
import { GatewayProtocolError, GW_JSON_END, GW_JSON_START } from "../protocol/types.ts";
import { extractToolCalls, hasToolCall } from "./parser.ts";
import { buildToolPrompt, detectLanguage } from "./prompt.ts";

export interface ConvertedPrompt {
	prompt: string;
	/** Whether tools are active after applying tool_choice */
	hasTools: boolean;
}

function detectLang(messages: ChatMessage[]): "en" | "cn" {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role === "user") {
			const text = typeof msg.content === "string" ? msg.content : "";
			return detectLanguage(text);
		}
	}
	return "en";
}

function extractTextContent(content: string | { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((p) => p.type === "text")
		.map((p) => p.text ?? "")
		.join("");
}

function historicalArguments(raw: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
	} catch {
		// Preserve malformed historical arguments as inert text instead of guessing.
	}
	return { _raw: raw };
}

function formatAssistantMsg(msg: AssistantMessage, canonical: boolean): string | null {
	if (msg.tool_calls && msg.tool_calls.length > 0) {
		if (canonical) {
			const calls = msg.tool_calls.map((tc) => ({
				name: tc.function.name,
				arguments: historicalArguments(tc.function.arguments),
			}));
			const envelope = {
				type: "tool_call" as const,
				calls,
				...(typeof msg.content === "string" ? { content: msg.content } : {}),
				...(typeof msg.reasoning_content === "string"
					? { reasoning_content: msg.reasoning_content }
					: {}),
			};
			return [
				"Assistant protocol action:",
				GW_JSON_START,
				JSON.stringify(envelope),
				GW_JSON_END,
			].join("\n");
		}

		const calls = msg.tool_calls.map(
			(tc) =>
				`\`\`\`tool_json\n{"tool":"${tc.function.name}","parameters":${tc.function.arguments}}\n\`\`\``,
		);
		return `Assistant: [Called tools]\n${calls.join("\n")}`;
	}

	if (canonical && (typeof msg.content === "string" || typeof msg.reasoning_content === "string")) {
		const envelope = {
			type: "message" as const,
			content: typeof msg.content === "string" ? msg.content : "",
			...(typeof msg.reasoning_content === "string"
				? { reasoning_content: msg.reasoning_content }
				: {}),
		};
		return [
			"Assistant protocol message:",
			GW_JSON_START,
			JSON.stringify(envelope),
			GW_JSON_END,
		].join("\n");
	}

	return msg.content ? `Assistant: ${msg.content}` : null;
}

function formatToolResult(msg: ToolMessage): string {
	return [`<tool_result tool_call_id="${msg.tool_call_id}">`, msg.content, "</tool_result>"].join(
		"\n",
	);
}

function formatMessage(msg: ChatMessage, canonical: boolean): string | null {
	switch (msg.role) {
		case "system":
		case "developer":
			return `System: ${msg.content}`;

		case "user":
			return `Human: ${extractTextContent(msg.content)}`;

		case "assistant":
			return formatAssistantMsg(msg as AssistantMessage, canonical);

		case "tool":
			return formatToolResult(msg as ToolMessage);

		default: {
			const legacy = msg as any;
			if (legacy.role === "function" && typeof legacy.content === "string") {
				return formatToolResult({
					role: "tool",
					tool_call_id: legacy.name ?? "unknown",
					content: legacy.content,
				});
			}
			return null;
		}
	}
}

export function resolveEffectiveTools(
	tools: ToolDefinition[] | undefined,
	toolChoice: ToolChoice | undefined,
): { tools: ToolDefinition[]; forceUse: boolean } {
	if (!tools || tools.length === 0) return { tools: [], forceUse: false };
	if (toolChoice === "none") return { tools: [], forceUse: false };
	if (toolChoice === "required") return { tools, forceUse: true };
	if (typeof toolChoice === "object" && toolChoice.type === "function") {
		const target = toolChoice.function.name;
		const filtered = tools.filter((t) => t.function.name === target);
		return { tools: filtered, forceUse: filtered.length > 0 };
	}
	return { tools, forceUse: false };
}

export function buildPromptFromMessages(
	messages: ChatMessage[],
	tools?: ToolDefinition[],
	toolChoice?: ToolChoice,
	compactTools = true,
): ConvertedPrompt {
	const effective = resolveEffectiveTools(tools, toolChoice);
	const hasTools = effective.tools.length > 0;
	const parts: string[] = [];
	const lang = detectLang(messages);

	if (hasTools)
		parts.push(buildToolPrompt(effective.tools, lang, effective.forceUse, compactTools));
	for (const msg of messages) {
		const formatted = formatMessage(msg, compactTools);
		if (formatted) parts.push(formatted);
	}

	const lastMsg = messages[messages.length - 1];
	const endsWithToolResult = lastMsg?.role === "tool" || (lastMsg as any)?.role === "function";
	if (endsWithToolResult) {
		parts.push(
			lang === "cn"
				? "请根据以上真实工具执行结果继续任务。"
				: "Continue the task using the real tool results above.",
		);
	}

	return { prompt: parts.join("\n\n"), hasTools };
}

function escapeStructuredIntentRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasStructuredToolIntent(
	text: string,
	requestedTools: ToolDefinition[] | undefined,
): boolean {
	if (text.includes(GW_JSON_START) || text.includes(GW_JSON_END)) return true;
	if (/"type"\s*:\s*"tool_call"/.test(text) || /"calls"\s*:/.test(text)) return true;
	if (/"name"\s*:\s*"[^"\r\n]+"[\s\S]{0,400}"arguments"\s*:/.test(text)) return true;
	if (/"arguments"\s*:[\s\S]{0,400}"name"\s*:\s*"[^"\r\n]+"/.test(text)) return true;

	for (const tool of requestedTools ?? []) {
		const name = escapeStructuredIntentRegex(tool.function.name);
		const jsonName = new RegExp(`"name"\\s*:\\s*"${name}"`);
		const xmlBlock = new RegExp(`<\\/?${name}(?:\\s[^>]*)?>`);
		if ((jsonName.test(text) && /"arguments"\s*:/.test(text)) || xmlBlock.test(text)) return true;
	}
	return false;
}

function parseStrictToolResponse(
	text: string,
	requestedTools: ToolDefinition[] | undefined,
	_allowTerminalProse: boolean,
) {
	try {
		const normalized = normalizeRawProtocolResponse(text, requestedTools);
		if (normalized.mode !== "exact-envelope") {
			console.warn(`[tool-calling] normalized raw provider output mode=${normalized.mode}`);
		}
		return normalized.parsed;
	} catch (error) {
		if (
			error instanceof GatewayProtocolError &&
			error.code === "missing_envelope" &&
			text.trim().length > 0
		) {
			if (hasStructuredToolIntent(text, requestedTools)) {
				console.warn(
					"[tool-calling] rejected malformed structured tool intent without protocol reinference",
				);
				throw new GatewayProtocolError(
					"model_protocol_error",
					"Provider response contained malformed structured tool intent and was rejected without semantic repair.",
				);
			}
			console.warn("[tool-calling] preserved terminal prose without protocol reinference");
			return {
				content: text,
				reasoningContent: undefined,
				toolCalls: undefined,
				finishReason: "stop" as const,
			};
		}
		throw error;
	}
}

/**
 * Parse text response and detect tool calls.
 * Strict mode still requires canonical GW_AGENT_PROTOCOL semantics for actions, but accepts
 * deterministic syntactic recovery from raw provider output before validation. Plain terminal
 * prose is preserved as a message for both streaming and non-streaming callers without asking
 * the provider to infer the task again. Malformed structured protocol still fails closed.
 * Natural-language intent is never inferred into an action.
 */
export function parseToolResponse(
	text: string,
	requestedTools?: ToolDefinition[],
	strictProtocol = false,
	allowTerminalProse = false,
): {
	content: string | null;
	reasoningContent?: string;
	toolCalls: ToolCallOutput[] | undefined;
	finishReason: "stop" | "tool_calls";
} {
	if (strictProtocol) return parseStrictToolResponse(text, requestedTools, allowTerminalProse);

	if (!requestedTools || requestedTools.length === 0 || !hasToolCall(text)) {
		return {
			content: text,
			reasoningContent: undefined,
			toolCalls: undefined,
			finishReason: "stop",
		};
	}

	const validToolNames = new Set(requestedTools.map((t) => t.function.name));
	const parsed = extractToolCalls(text);
	const validCalls = parsed.filter((c) => validToolNames.has(c.name));

	if (validCalls.length === 0) {
		return {
			content: text,
			reasoningContent: undefined,
			toolCalls: undefined,
			finishReason: "stop",
		};
	}

	const toolCalls: ToolCallOutput[] = validCalls.map((call) => ({
		id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
		type: "function" as const,
		function: {
			name: call.name,
			arguments: JSON.stringify(call.arguments),
		},
	}));

	return {
		content: null,
		reasoningContent: undefined,
		toolCalls,
		finishReason: "tool_calls",
	};
}
