import type { ToolCallOutput, ToolDefinition } from "../openai/types.ts";
import { validateToolArguments } from "./schema-validator.ts";
import {
	GW_JSON_END,
	GW_JSON_START,
	GatewayProtocolError,
	type GatewayEnvelope,
	type GatewayToolCall,
} from "./types.ts";

export interface CanonicalToolResponse {
	content: string | null;
	toolCalls: ToolCallOutput[] | undefined;
	finishReason: "stop" | "tool_calls";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countOccurrences(text: string, needle: string): number {
	let count = 0;
	let offset = 0;
	while (true) {
		const index = text.indexOf(needle, offset);
		if (index < 0) return count;
		count += 1;
		offset = index + needle.length;
	}
}

export function extractGatewayJson(text: string): string {
	const starts = countOccurrences(text, GW_JSON_START);
	const ends = countOccurrences(text, GW_JSON_END);
	if (starts === 0 || ends === 0) {
		throw new GatewayProtocolError(
			"missing_envelope",
			`Response must contain exactly one ${GW_JSON_START} ... ${GW_JSON_END} envelope.`,
		);
	}
	if (starts !== 1 || ends !== 1) {
		throw new GatewayProtocolError(
			"multiple_envelopes",
			`Response contained ${starts} opening and ${ends} closing protocol markers.`,
		);
	}

	const start = text.indexOf(GW_JSON_START);
	const end = text.indexOf(GW_JSON_END, start + GW_JSON_START.length);
	if (end < start) {
		throw new GatewayProtocolError("invalid_envelope", "Protocol envelope markers are out of order.");
	}

	const before = text.slice(0, start).trim();
	const after = text.slice(end + GW_JSON_END.length).trim();
	if (before || after) {
		throw new GatewayProtocolError(
			"trailing_content",
			"Protocol responses may contain only the GW_JSON envelope and surrounding whitespace.",
		);
	}

	return text.slice(start + GW_JSON_START.length, end).trim();
}

function parseToolCall(value: unknown, index: number): GatewayToolCall {
	if (!isRecord(value)) {
		throw new GatewayProtocolError("invalid_envelope", `calls[${index}] must be an object.`);
	}
	if (typeof value.name !== "string" || value.name.trim().length === 0) {
		throw new GatewayProtocolError("invalid_envelope", `calls[${index}].name must be a non-empty string.`);
	}
	if (!isRecord(value.arguments)) {
		throw new GatewayProtocolError("invalid_envelope", `calls[${index}].arguments must be a JSON object.`);
	}
	return { name: value.name.trim(), arguments: value.arguments };
}

export function parseGatewayEnvelope(text: string): GatewayEnvelope {
	const raw = extractGatewayJson(text);
	let decoded: unknown;
	try {
		decoded = JSON.parse(raw);
	} catch (error) {
		throw new GatewayProtocolError(
			"invalid_json",
			`GW_JSON payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (!isRecord(decoded) || typeof decoded.type !== "string") {
		throw new GatewayProtocolError("invalid_envelope", "GW_JSON payload must be an object with a type field.");
	}

	switch (decoded.type) {
		case "message":
			if (typeof decoded.content !== "string") {
				throw new GatewayProtocolError("invalid_envelope", "message.content must be a string.");
			}
			return { type: "message", content: decoded.content };

		case "tool_call": {
			if (!Array.isArray(decoded.calls) || decoded.calls.length === 0) {
				throw new GatewayProtocolError("invalid_envelope", "tool_call.calls must be a non-empty array.");
			}
			return { type: "tool_call", calls: decoded.calls.map(parseToolCall) };
		}

		case "error":
			if (typeof decoded.message !== "string" || decoded.message.trim().length === 0) {
				throw new GatewayProtocolError("invalid_envelope", "error.message must be a non-empty string.");
			}
			return { type: "error", message: decoded.message.trim() };

		default:
			throw new GatewayProtocolError(
				"invalid_envelope",
				`Unsupported GW_JSON envelope type: ${String(decoded.type)}`,
			);
	}
}

export function parseCanonicalToolResponse(
	text: string,
	requestedTools?: ToolDefinition[],
): CanonicalToolResponse {
	const envelope = parseGatewayEnvelope(text);
	if (envelope.type === "message") {
		return { content: envelope.content, toolCalls: undefined, finishReason: "stop" };
	}
	if (envelope.type === "error") {
		throw new GatewayProtocolError("model_protocol_error", envelope.message);
	}

	if (!requestedTools || requestedTools.length === 0) {
		throw new GatewayProtocolError(
			"unexpected_tool_call",
			"Model requested a tool call but the client exposed no tools.",
		);
	}

	const toolsByName = new Map(requestedTools.map((tool) => [tool.function.name, tool]));
	const toolCalls: ToolCallOutput[] = envelope.calls.map((call) => {
		const tool = toolsByName.get(call.name);
		if (!tool) {
			throw new GatewayProtocolError("unknown_tool", `Model requested unknown tool: ${call.name}`);
		}
		const issues = validateToolArguments(tool, call.arguments);
		if (issues.length > 0) {
			throw new GatewayProtocolError(
				"invalid_arguments",
				`Arguments for tool ${call.name} failed schema validation.`,
				{ tool: call.name, issues },
			);
		}
		return {
			id: `call_gw_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
			type: "function" as const,
			function: {
				name: call.name,
				arguments: JSON.stringify(call.arguments),
			},
		};
	});

	return { content: null, toolCalls, finishReason: "tool_calls" };
}
