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
	test("optimized tool prompt prevents fabricated execution", () => {
		const prompt = buildToolPrompt(STRUCTURED_TOOLS, "en", false, true);
		expect(prompt).toContain("API backend mode:");
		expect(prompt).toContain("Never claim a tool ran unless a real <tool_result> was provided");
	});

	test("StructuredOutput is reserved for the final validated handoff", () => {
		const prompt = buildToolPrompt(STRUCTURED_TOOLS, "en", false, true);
		expect(prompt).toContain("Structured output is enabled via the StructuredOutput tool");
		expect(prompt).toContain("Use normal tools first if the task requires work");
		expect(prompt).toContain("call StructuredOutput exactly once");
	});

	test("passthrough mode does not inject the optimized backend wrapper", () => {
		const prompt = buildToolPrompt(STRUCTURED_TOOLS, "en", false, false);
		expect(prompt).not.toContain("API backend mode:");
		expect(prompt).toContain("Structured output is enabled via the StructuredOutput tool");
	});
});
