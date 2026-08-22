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

const READ_TOOL = {
	type: "function" as const,
	function: {
		name: "read",
		description: "Read file",
		parameters: {
			type: "object",
			properties: { filePath: { type: "string" } },
			required: ["filePath"],
			additionalProperties: false,
		},
	},
};

const GLOB_TOOL = {
	type: "function" as const,
	function: {
		name: "glob",
		description: "Find files",
		parameters: {
			type: "object",
			properties: { pattern: { type: "string" } },
			required: ["pattern"],
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

	test("recovers observed XML-like parallel tool calls without semantic inference", () => {
		const raw = `I'll inspect the project first.

<read>
<filePath>C:\\Users\\admin\\agentic-e2e\\AGENTS.md</filePath>
</read>
<read>
<filePath>C:\\Users\\admin\\agentic-e2e\\package.json</filePath>
</read>
<glob>
<pattern>**/*.ts</pattern>
</glob>
<glob>
<pattern>**/*.js</pattern>
</glob>`;
		const result = normalizeRawProtocolResponse(raw, [READ_TOOL, GLOB_TOOL]);
		expect(result.mode).toBe("xml-tool-calls");
		expect(result.parsed.finishReason).toBe("tool_calls");
		expect(result.parsed.toolCalls).toHaveLength(4);
		expect(result.parsed.toolCalls?.map((call) => call.function.name)).toEqual([
			"read",
			"read",
			"glob",
			"glob",
		]);
		expect(JSON.parse(result.parsed.toolCalls?.[0]?.function.arguments ?? "{}")).toEqual({
			filePath: "C:\\Users\\admin\\agentic-e2e\\AGENTS.md",
		});
	});

	test("rejects unknown XML-like tools when mixed with known calls", () => {
		const raw = `<read><filePath>AGENTS.md</filePath></read>\n<delete><path>src</path></delete>`;
		try {
			normalizeRawProtocolResponse(raw, [READ_TOOL]);
			throw new Error("expected protocol error");
		} catch (error) {
			expect(error).toBeInstanceOf(GatewayProtocolError);
			expect((error as GatewayProtocolError).code).toBe("unknown_tool");
		}
	});

	test("rejects unknown XML-like arguments instead of guessing", () => {
		const raw = `<read><path>AGENTS.md</path></read>`;
		try {
			normalizeRawProtocolResponse(raw, [READ_TOOL]);
			throw new Error("expected protocol error");
		} catch (error) {
			expect(error).toBeInstanceOf(GatewayProtocolError);
			expect((error as GatewayProtocolError).code).toBe("invalid_arguments");
		}
	});

	test("rejects malformed or nested XML-like arguments", () => {
		const raw = `<read><filePath><nested>AGENTS.md</nested></filePath></read>`;
		expect(() => normalizeRawProtocolResponse(raw, [READ_TOOL])).toThrow(GatewayProtocolError);
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
