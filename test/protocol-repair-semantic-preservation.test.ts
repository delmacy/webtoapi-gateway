import { describe, expect, test } from "bun:test";
import { handleChatCompletions } from "../src/openai/chat-completions.ts";
import type { ChatCompletionRequest } from "../src/openai/types.ts";
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

function canonicalMessage(content: string): string {
	return `${GW_JSON_START}\n${JSON.stringify({ type: "message", content })}\n${GW_JSON_END}`;
}

function createSequenceClient(responses: string[]) {
	let calls = 0;
	return {
		providerId: `semantic-repair-test-${crypto.randomUUID()}`,
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
		parseStream: async (body: ReadableStream<Uint8Array>, onDelta?: (delta: string) => void) =>
			parseClaudeStream(body, onDelta),
		listModels: () => [{ id: "test-model", name: "Test" }],
	};
}

function parseSseChunks(text: string): Record<string, unknown>[] {
	return text
		.split("\n\n")
		.map((event) => event.trim())
		.filter((event) => event.startsWith("data: ") && event !== "data: [DONE]")
		.map((event) => JSON.parse(event.slice("data: ".length)) as Record<string, unknown>);
}

describe("protocol repair semantic preservation E2E", () => {
	test("streaming plain terminal prose is returned verbatim and never triggers a second provider inference", async () => {
		const blocked = [
			"TASK-158 blocked: required behavior is not currently observable within the allowed scope.",
			"Stop. No changes made.",
		].join("\n");
		const fabricated = canonicalMessage(
			"TASK-158 EXECUTED. Files changed, validations passed, commit SHA: 4f8b3c9e1d2a5b7c8f9e0d1a2b3c4d5e6f7a8b9c.",
		);
		const client = createSequenceClient([blocked, fabricated]);
		const body: ChatCompletionRequest = {
			model: "test-model",
			stream: true,
			messages: [{ role: "user", content: "Execute TASK-158 and stop if blocked." }],
			tools: [EXEC_TOOL],
		};

		const res = await handleChatCompletions(body, client as any);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/event-stream");
		expect(client.calls).toBe(1);

		const text = await res.text();
		const chunks = parseSseChunks(text);
		const contents = chunks
			.map((chunk) => {
				const choices = chunk.choices;
				if (!Array.isArray(choices)) return undefined;
				const first = choices[0];
				if (typeof first !== "object" || first === null) return undefined;
				const delta = (first as { delta?: unknown }).delta;
				if (typeof delta !== "object" || delta === null) return undefined;
				const content = (delta as { content?: unknown }).content;
				return typeof content === "string" ? content : undefined;
			})
			.filter((content): content is string => content !== undefined);
		const finishReasons = chunks
			.map((chunk) => {
				const choices = chunk.choices;
				if (!Array.isArray(choices)) return undefined;
				const first = choices[0];
				if (typeof first !== "object" || first === null) return undefined;
				const finishReason = (first as { finish_reason?: unknown }).finish_reason;
				return typeof finishReason === "string" ? finishReason : undefined;
			})
			.filter((reason): reason is string => reason !== undefined);

		expect(contents.join("")).toBe(blocked);
		expect(finishReasons).toContain("stop");
		expect(text).not.toContain("TASK-158 EXECUTED");
		expect(text).not.toContain("4f8b3c9e1d2a5b7c8f9e0d1a2b3c4d5e6f7a8b9c");
	});
});
