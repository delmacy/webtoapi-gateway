import { describe, expect, test } from "bun:test";
import {
	configureAgentLayer,
	handleChatCompletions,
	setRouteTimeoutSec,
} from "../src/openai/chat-completions.ts";
import type { ChatCompletionRequest } from "../src/openai/types.ts";
import type { ProviderSendParams, StreamResult, WebProviderClient } from "../src/providers/types.ts";

const RUNTIME_CONFIG = {
	mode: "optimized" as const,
	sessionIdleTtlSec: 3600,
	maxToolTurns: 40,
	maxIdenticalToolCalls: 2,
	toolResultMaxChars: 12_000,
	preserveTailMessages: 6,
	telemetry: false,
};

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

describe("route timeout abort", () => {
	test("aborts a stuck provider and releases the fair-use lease", async () => {
		configureAgentLayer(RUNTIME_CONFIG, { maxConcurrency: 1, minIntervalMs: 0 });
		setRouteTimeoutSec(0.02);
		let sendCount = 0;
		let observedAbort = false;

		const client: WebProviderClient = {
			providerId: `timeout-test-${crypto.randomUUID()}`,
			async init() {},
			async sendMessage(params: ProviderSendParams) {
				sendCount += 1;
				if (sendCount === 1) {
					return new Promise<ReadableStream<Uint8Array>>((_, reject) => {
						params.signal?.addEventListener(
							"abort",
							() => {
								observedAbort = true;
								reject(new Error("provider request aborted"));
							},
							{ once: true },
						);
					});
				}
				return textStream("ok");
			},
			async parseStream(body): Promise<StreamResult> {
				return { text: await readStream(body), thinkingText: "" };
			},
			listModels: () => [{ id: "timeout-model", name: "Timeout Model" }],
		};

		const firstBody: ChatCompletionRequest = {
			model: "timeout-model",
			messages: [{ role: "user", content: `block-${crypto.randomUUID()}` }],
		};

		try {
			const first = await handleChatCompletions(firstBody, client);
			expect(first.status).toBe(504);
			expect(observedAbort).toBe(true);

			setRouteTimeoutSec(1);
			const secondBody: ChatCompletionRequest = {
				model: "timeout-model",
				messages: [{ role: "user", content: `continue-${crypto.randomUUID()}` }],
			};
			const second = await Promise.race([
				handleChatCompletions(secondBody, client),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("fair-use lease remained stuck after abort")), 500),
				),
			]);
			expect(second.status).toBe(200);
			expect(sendCount).toBe(2);
		} finally {
			setRouteTimeoutSec(300);
			configureAgentLayer(RUNTIME_CONFIG, { maxConcurrency: 1, minIntervalMs: 2500 });
		}
	});
});
