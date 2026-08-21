import { describe, expect, test } from "bun:test";
import { handleChatCompletions } from "../src/openai/chat-completions.ts";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../src/openai/types.ts";
import { GW_JSON_END, GW_JSON_START } from "../src/protocol/types.ts";
import { parseClaudeStream } from "../src/providers/claude/stream.ts";

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

function canonical(value: unknown): string {
	return `${GW_JSON_START}\n${JSON.stringify(value)}\n${GW_JSON_END}`;
}

function createSequenceClient(responses: string[]) {
	let calls = 0;
	return {
		providerId: `repair-test-${crypto.randomUUID()}`,
		init: async () => {},
		get calls() {
			return calls;
		},
		sendMessage: async () => {
			const responseText = responses[Math.min(calls, responses.length - 1)] ?? "";
			calls += 1;
			const encoder = new TextEncoder();
			const sseData = JSON.stringify({
				type: "content_block_delta",
				delta: { text: responseText },
			});
			return new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(`data: ${sseData}\n\n`));
					controller.close();
				},
			});
		},
		parseStream: async (body: ReadableStream<Uint8Array>, onDelta?: (d: string) => void) =>
			parseClaudeStream(body, onDelta),
		listModels: () => [{ id: "test-model", name: "Test" }],
	};
}

describe("single protocol repair", () => {
	test("repairs a serialization-only trailing_content failure once", async () => {
		const intended = canonical({
			type: "tool_call",
			calls: [{ name: "exec", arguments: { command: "ls" } }],
		});
		const client = createSequenceClient([`${intended}\nextra prose`, intended]);
		const body: ChatCompletionRequest = {
			model: "test-model",
			messages: [{ role: "user", content: "List files" }],
			tools: [EXEC_TOOL],
		};

		const res = await handleChatCompletions(body, client as any);
		expect(res.status).toBe(200);
		expect(client.calls).toBe(1);
		const json = (await res.json()) as ChatCompletionResponse;
		expect(json.choices[0]?.finish_reason).toBe("tool_calls");
		expect(json.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("exec");
	});

	test("does not repair semantic unknown_tool failures", async () => {
		const client = createSequenceClient([
			canonical({
				type: "tool_call",
				calls: [{ name: "not_allowed", arguments: {} }],
			}),
		]);
		const body: ChatCompletionRequest = {
			model: "test-model",
			messages: [{ role: "user", content: "List files" }],
			tools: [EXEC_TOOL],
		};

		const res = await handleChatCompletions(body, client as any);
		expect(res.status).toBe(502);
		expect(client.calls).toBe(1);
		const json = (await res.json()) as { error: { code: string } };
		expect(json.error.code).toBe("unknown_tool");
	});
});
