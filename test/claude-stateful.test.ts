import { describe, expect, test } from "bun:test";
import { configureAgentLayer, handleChatCompletions } from "../src/openai/chat-completions.ts";
import type {
	ChatCompletionRequest,
	ChatCompletionResponse,
	ToolDefinition,
} from "../src/openai/types.ts";
import { GW_JSON_END, GW_JSON_START } from "../src/protocol/types.ts";
import type {
	ProviderSendParams,
	StreamResult,
	WebProviderClient,
} from "../src/providers/types.ts";

const READ_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "read",
		description: "Read a file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
			additionalProperties: false,
		},
	},
};

function canonical(value: unknown): string {
	return `${GW_JSON_START}\n${JSON.stringify(value)}\n${GW_JSON_END}`;
}

function textStream(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

async function readStream(body: ReadableStream<Uint8Array>): Promise<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}

describe("Claude stateful routing", () => {
	test("uses stateful affinity, idempotent retry, and tool-result delta continuation", async () => {
		configureAgentLayer(
			{
				mode: "optimized",
				sessionIdleTtlSec: 3600,
				maxToolTurns: 40,
				maxIdenticalToolCalls: 2,
				toolResultMaxChars: 12_000,
				preserveTailMessages: 6,
				telemetry: false,
			},
			{ maxConcurrency: 1, minIntervalMs: 0 },
		);

		const sends: ProviderSendParams[] = [];
		const responses = [
			canonical({
				type: "tool_call",
				calls: [{ name: "read", arguments: { path: "package.json" } }],
			}),
			canonical({ type: "message", content: "Package name is gateway." }),
		];
		const client: WebProviderClient = {
			providerId: "claude-web",
			sessionCapabilities: {
				persistentConversation: true,
				deltaPrompts: true,
				resettable: true,
			},
			async init() {},
			async sendMessage(params) {
				sends.push({ ...params });
				const response = responses[sends.length - 1];
				if (response === undefined) throw new Error("Unexpected extra Claude provider call");
				return textStream(response);
			},
			async parseStream(body, onDelta): Promise<StreamResult> {
				const text = await readStream(body);
				onDelta?.(text);
				return { text, thinkingText: "" };
			},
			listModels: () => [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
		};

		const session = `claude-stateful-${crypto.randomUUID()}`;
		const initial: ChatCompletionRequest = {
			model: "claude-sonnet-4-6",
			messages: [{ role: "user", content: "Read package.json" }],
			tools: [READ_TOOL],
		};

		const first = await handleChatCompletions(initial, client, { sessionIdOverride: session });
		expect(first.status).toBe(200);
		expect(first.headers.get("x-webtoapi-stateful")).toBe("true");
		expect(first.headers.get("x-webtoapi-prompt-mode")).toBe("full");
		const firstJson = (await first.json()) as ChatCompletionResponse;
		const toolCall = firstJson.choices[0]?.message.tool_calls?.[0];
		expect(toolCall?.function.name).toBe("read");
		expect(sends).toHaveLength(1);
		expect(sends[0]?.resetSession).toBe(true);

		const retry = await handleChatCompletions(initial, client, { sessionIdOverride: session });
		expect(retry.status).toBe(200);
		expect(retry.headers.get("x-webtoapi-history-relation")).toBe("exact");
		expect(retry.headers.get("x-webtoapi-response-cache")).toBe("hit");
		const retryJson = (await retry.json()) as ChatCompletionResponse;
		expect(retryJson.choices[0]?.message.tool_calls?.[0]?.id).toBe(toolCall?.id);
		expect(sends).toHaveLength(1);

		const continuation: ChatCompletionRequest = {
			...initial,
			messages: [
				...initial.messages,
				{
					role: "assistant",
					content: null,
					tool_calls: toolCall ? [toolCall] : [],
				},
				{
					role: "tool",
					tool_call_id: toolCall?.id ?? "missing",
					content: '{"name":"gateway"}',
				},
			],
		};
		const final = await handleChatCompletions(continuation, client, {
			sessionIdOverride: session,
		});
		expect(final.status).toBe(200);
		expect(final.headers.get("x-webtoapi-history-relation")).toBe("append");
		expect(final.headers.get("x-webtoapi-prompt-mode")).toBe("delta");
		const finalJson = (await final.json()) as ChatCompletionResponse;
		expect(finalJson.choices[0]?.message.content).toBe("Package name is gateway.");
		expect(sends).toHaveLength(2);
		expect(sends[1]?.statefulSession).toBe(true);
		expect(sends[1]?.resetSession).toBe(false);
		expect(sends[1]?.message).toContain("<tool_result");
		expect(sends[1]?.message).toContain('{"name":"gateway"}');
		expect(sends[1]?.message).not.toContain("Human: Read package.json");
		expect(sends[1]?.message).not.toContain("[Called tools]");
	});
});
