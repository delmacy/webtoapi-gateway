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

function configureTests(): void {
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
}

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

function createStatefulMock(responses: string[]) {
	const sends: ProviderSendParams[] = [];
	const client: WebProviderClient = {
		providerId: "deepseek-web",
		sessionCapabilities: {
			persistentConversation: true,
			deltaPrompts: true,
			resettable: true,
		},
		async init() {},
		async sendMessage(params) {
			sends.push({ ...params });
			const response = responses[sends.length - 1];
			if (response === undefined) throw new Error("Unexpected extra provider call");
			return textStream(response);
		},
		async parseStream(body, onDelta): Promise<StreamResult> {
			const text = await readStream(body);
			onDelta?.(text);
			return { text, thinkingText: "" };
		},
		listModels: () => [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
	};
	return { client, sends };
}

function firstRequest(): ChatCompletionRequest {
	return {
		model: "deepseek-chat",
		messages: [{ role: "user", content: "Read package.json" }],
		tools: [READ_TOOL],
	};
}

describe("stateful chat completions", () => {
	test("exact retry is served from cache and append sends only the tool result delta", async () => {
		configureTests();
		const session = `stateful-retry-${crypto.randomUUID()}`;
		const { client, sends } = createStatefulMock([
			canonical({
				type: "tool_call",
				calls: [{ name: "read", arguments: { path: "package.json" } }],
			}),
			canonical({ type: "message", content: "Package name is gateway." }),
		]);

		const body = firstRequest();
		const first = await handleChatCompletions(body, client, { sessionIdOverride: session });
		expect(first.status).toBe(200);
		expect(first.headers.get("x-webtoapi-stateful")).toBe("true");
		expect(first.headers.get("x-webtoapi-prompt-mode")).toBe("full");
		expect(first.headers.get("x-webtoapi-response-cache")).toBe("miss");
		const firstJson = (await first.json()) as ChatCompletionResponse;
		const toolCall = firstJson.choices[0]?.message.tool_calls?.[0];
		expect(toolCall?.function.name).toBe("read");
		expect(sends).toHaveLength(1);
		expect(sends[0]?.statefulSession).toBe(true);
		expect(sends[0]?.resetSession).toBe(true);

		const retry = await handleChatCompletions(body, client, { sessionIdOverride: session });
		expect(retry.status).toBe(200);
		expect(retry.headers.get("x-webtoapi-history-relation")).toBe("exact");
		expect(retry.headers.get("x-webtoapi-response-cache")).toBe("hit");
		const retryJson = (await retry.json()) as ChatCompletionResponse;
		expect(retryJson.choices[0]?.message.tool_calls?.[0]?.id).toBe(toolCall?.id);
		expect(sends).toHaveLength(1);

		const continuation: ChatCompletionRequest = {
			...body,
			messages: [
				...body.messages,
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

	test("auto-derived session ids never enable upstream affinity", async () => {
		configureTests();
		const { client, sends } = createStatefulMock([
			canonical({ type: "message", content: "No tool needed." }),
		]);
		const body: ChatCompletionRequest = {
			model: "deepseek-chat",
			messages: [{ role: "user", content: `Unique auto ${crypto.randomUUID()}` }],
			tools: [READ_TOOL],
		};
		const response = await handleChatCompletions(body, client);
		expect(response.status).toBe(200);
		expect(response.headers.get("x-webtoapi-session-source")).toBe("auto");
		expect(response.headers.get("x-webtoapi-stateful")).toBe("false");
		expect(response.headers.get("x-webtoapi-response-cache")).toBe("disabled");
		expect(sends).toHaveLength(1);
		expect(sends[0]?.statefulSession).toBe(false);
		expect(sends[0]?.sessionId).toBeUndefined();
		expect(sends[0]?.message).toContain("Human: Unique auto");
	});
});
