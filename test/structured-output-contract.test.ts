import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "../src/openai/types.ts";
import { buildToolPrompt } from "../src/tool-calling/prompt.ts";

const STRUCTURED_TOOLS: ToolDefinition[] = [
	{
		type: "function",
		function: {
			name: "read",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "StructuredOutput",
			description: "Return the final validated structured result",
			parameters: {
				type: "object",
				properties: {
					status: { type: "string" },
					summary: { type: "string" },
				},
				required: ["status", "summary"],
			},
		},
	},
];

describe("API backend tool contract", () => {
	test("optimized action prompt prevents fabricated execution", () => {
		const prompt = buildToolPrompt(STRUCTURED_TOOLS, "en", false, true);
		expect(prompt).toContain("API backend serialization mode");
		expect(prompt).toContain("GW_AGENT_PROTOCOL/1");
		expect(prompt).toContain(
			"Never claim an external action ran unless a real <tool_result> was provided",
		);
	});

	test("StructuredOutput is reserved for the final validated handoff", () => {
		const prompt = buildToolPrompt(STRUCTURED_TOOLS, "en", false, true);
		expect(prompt).toContain("StructuredOutput is the final structured handoff action");
		expect(prompt).toContain("Request and await real results from other external actions first");
		expect(prompt).toContain("request StructuredOutput exactly once");
	});

	test("passthrough mode does not inject the canonical backend wrapper", () => {
		const prompt = buildToolPrompt(STRUCTURED_TOOLS, "en", false, false);
		expect(prompt).not.toContain("GW_AGENT_PROTOCOL/1");
		expect(prompt).toContain("Structured output is enabled via the StructuredOutput tool");
	});
});
