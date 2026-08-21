import { describe, expect, test } from "bun:test";
import { normalizeRawProtocolResponse } from "../src/protocol/raw-normalizer.ts";
import { GatewayProtocolError, GW_JSON_END, GW_JSON_START } from "../src/protocol/types.ts";

const EXEC_TOOL = {
	type: "function" as const,
	function: {
		name: "exec",
		description: "Run command",
		parameters: {
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
			additionalProperties: false,
		},
	},
};

const action = JSON.stringify({
	type: "tool_call",
	calls: [{ name: "exec", arguments: { command: "ls" } }],
});

function canonical(json: string): string {
	return `${GW_JSON_START}\n${json}\n${GW_JSON_END}`;
}

describe("raw protocol normalizer", () => {
	test("keeps an exact canonical envelope unchanged", () => {
		const result = normalizeRawProtocolResponse(canonical(action), [EXEC_TOOL]);
		expect(result.mode).toBe("exact-envelope");
		expect(result.parsed.finishReason).toBe("tool_calls");
	});

	test("recovers one canonical envelope surrounded by prose", () => {
		const result = normalizeRawProtocolResponse(`before\n${canonical(action)}\nafter`, [EXEC_TOOL]);
		expect(result.mode).toBe("envelope-with-prose");
		expect(result.parsed.toolCalls?.[0]?.function.name).toBe("exec");
	});

	test("recovers a bare canonical JSON object", () => {
		const result = normalizeRawProtocolResponse(action, [EXEC_TOOL]);
		expect(result.mode).toBe("bare-json");
		expect(result.parsed.finishReason).toBe("tool_calls");
	});

	test("recovers canonical JSON inside a markdown fence", () => {
		const result = normalizeRawProtocolResponse(`Here:\n\`\`\`json\n${action}\n\`\`\``, [
			EXEC_TOOL,
		]);
		expect(result.mode).toBe("fenced-json");
		expect(result.parsed.toolCalls).toHaveLength(1);
	});

	test("recovers one embedded canonical JSON object from inert prose", () => {
		const result = normalizeRawProtocolResponse(`I will serialize it now:\n${action}\nDone.`, [
			EXEC_TOOL,
		]);
		expect(result.mode).toBe("embedded-json");
		expect(result.parsed.toolCalls?.[0]?.function.arguments).toBe('{"command":"ls"}');
	});

	test("does not infer natural language into a tool call", () => {
		expect(() => normalizeRawProtocolResponse("I will run exec with ls now.", [EXEC_TOOL])).toThrow(
			GatewayProtocolError,
		);
	});

	test("rejects multiple JSON objects instead of choosing one", () => {
		expect(() => normalizeRawProtocolResponse(`${action}\n${action}`, [EXEC_TOOL])).toThrow(
			GatewayProtocolError,
		);
	});

	test("semantic validation still rejects unknown tools", () => {
		const unknown = JSON.stringify({
			type: "tool_call",
			calls: [{ name: "not_allowed", arguments: {} }],
		});
		try {
			normalizeRawProtocolResponse(unknown, [EXEC_TOOL]);
			throw new Error("expected protocol error");
		} catch (error) {
			expect(error).toBeInstanceOf(GatewayProtocolError);
			expect((error as GatewayProtocolError).code).toBe("unknown_tool");
		}
	});
});
