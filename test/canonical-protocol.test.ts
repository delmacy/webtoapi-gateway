import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "../src/openai/types.ts";
import {
	extractGatewayJson,
	parseCanonicalToolResponse,
	parseGatewayEnvelope,
} from "../src/protocol/parser.ts";
import { validateToolArguments } from "../src/protocol/schema-validator.ts";
import { GW_JSON_END, GW_JSON_START, GatewayProtocolError } from "../src/protocol/types.ts";

const EXEC_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "exec",
		description: "Run a command",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", minLength: 1 },
				timeout: { type: "integer", minimum: 1 },
			},
			required: ["command"],
			additionalProperties: false,
		},
	},
};

function envelope(value: unknown): string {
	return `${GW_JSON_START}\n${JSON.stringify(value)}\n${GW_JSON_END}`;
}

function expectProtocolError(fn: () => unknown, code: string): GatewayProtocolError {
	try {
		fn();
		throw new Error("Expected GatewayProtocolError");
	} catch (error) {
		expect(error).toBeInstanceOf(GatewayProtocolError);
		const protocolError = error as GatewayProtocolError;
		expect(protocolError.code).toBe(code);
		return protocolError;
	}
}

describe("GW_AGENT_PROTOCOL/1 envelope", () => {
	test("parses a canonical message envelope", () => {
		const parsed = parseGatewayEnvelope(envelope({ type: "message", content: "done" }));
		expect(parsed).toEqual({ type: "message", content: "done" });
	});

	test("allows only surrounding whitespace outside the envelope", () => {
		const text = `  \n${envelope({ type: "message", content: "ok" })}\n  `;
		expect(JSON.parse(extractGatewayJson(text))).toEqual({ type: "message", content: "ok" });
	});

	test("rejects plain text without an envelope", () => {
		expectProtocolError(() => parseGatewayEnvelope("I will call exec now"), "missing_envelope");
	});

	test("rejects content outside the envelope", () => {
		expectProtocolError(
			() => parseGatewayEnvelope(`explanation\n${envelope({ type: "message", content: "ok" })}`),
			"trailing_content",
		);
	});

	test("rejects multiple protocol envelopes", () => {
		const text = `${envelope({ type: "message", content: "one" })}\n${envelope({ type: "message", content: "two" })}`;
		expectProtocolError(() => parseGatewayEnvelope(text), "multiple_envelopes");
	});

	test("rejects invalid JSON instead of repairing it", () => {
		const text = `${GW_JSON_START}\n{"type":"tool_call","calls":[}\n${GW_JSON_END}`;
		expectProtocolError(() => parseGatewayEnvelope(text), "invalid_json");
	});
});

describe("canonical tool calls", () => {
	test("converts a validated tool request to OpenAI tool_calls", () => {
		const text = envelope({
			type: "tool_call",
			calls: [{ name: "exec", arguments: { command: "ls", timeout: 30 } }],
		});
		const result = parseCanonicalToolResponse(text, [EXEC_TOOL]);
		expect(result.finishReason).toBe("tool_calls");
		expect(result.content).toBeNull();
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls?.[0]?.id).toMatch(/^call_gw_[a-f0-9]+$/);
		expect(result.toolCalls?.[0]?.function.name).toBe("exec");
		expect(JSON.parse(result.toolCalls?.[0]?.function.arguments ?? "{}")).toEqual({
			command: "ls",
			timeout: 30,
		});
	});

	test("supports multiple validated tool calls", () => {
		const text = envelope({
			type: "tool_call",
			calls: [
				{ name: "exec", arguments: { command: "pwd" } },
				{ name: "exec", arguments: { command: "ls" } },
			],
		});
		const result = parseCanonicalToolResponse(text, [EXEC_TOOL]);
		expect(result.toolCalls).toHaveLength(2);
		expect(result.toolCalls?.[0]?.id).not.toBe(result.toolCalls?.[1]?.id);
	});

	test("rejects unknown tool names rather than treating them as text", () => {
		const text = envelope({ type: "tool_call", calls: [{ name: "delete_everything", arguments: {} }] });
		expectProtocolError(() => parseCanonicalToolResponse(text, [EXEC_TOOL]), "unknown_tool");
	});

	test("rejects tool calls when the request exposed no tools", () => {
		const text = envelope({ type: "tool_call", calls: [{ name: "exec", arguments: { command: "ls" } }] });
		expectProtocolError(() => parseCanonicalToolResponse(text), "unexpected_tool_call");
	});

	test("rejects missing required arguments", () => {
		const text = envelope({ type: "tool_call", calls: [{ name: "exec", arguments: {} }] });
		const error = expectProtocolError(
			() => parseCanonicalToolResponse(text, [EXEC_TOOL]),
			"invalid_arguments",
		);
		expect(JSON.stringify(error.details)).toContain("command");
	});

	test("rejects wrong argument types and additional properties", () => {
		const text = envelope({
			type: "tool_call",
			calls: [{ name: "exec", arguments: { command: 42, surprise: true } }],
		});
		const error = expectProtocolError(
			() => parseCanonicalToolResponse(text, [EXEC_TOOL]),
			"invalid_arguments",
		);
		const details = JSON.stringify(error.details);
		expect(details).toContain("type string");
		expect(details).toContain("surprise");
	});

	test("returns message envelopes as normal assistant content", () => {
		const result = parseCanonicalToolResponse(envelope({ type: "message", content: "finished" }), [
			EXEC_TOOL,
		]);
		expect(result).toEqual({ content: "finished", toolCalls: undefined, finishReason: "stop" });
	});
});

describe("schema validator", () => {
	test("accepts a valid tool argument object", () => {
		expect(validateToolArguments(EXEC_TOOL, { command: "echo ok", timeout: 10 })).toEqual([]);
	});

	test("enforces integer minimum", () => {
		const issues = validateToolArguments(EXEC_TOOL, { command: "echo ok", timeout: 0 });
		expect(issues.some((issue) => issue.path === "$.timeout")).toBe(true);
	});
});
