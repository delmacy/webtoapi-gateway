import { describe, expect, test } from "bun:test";
import type { ChatCompletionRequest } from "../src/openai/types.ts";
import { AgentResponseCache, fingerprintChatRequest } from "../src/session/response-cache.ts";

function body(command = "ls"): ChatCompletionRequest {
	return {
		model: "deepseek-chat",
		messages: [{ role: "user", content: `Run ${command}` }],
		tools: [
			{
				type: "function",
				function: {
					name: "exec",
					parameters: {
						type: "object",
						properties: { command: { type: "string" } },
					},
				},
			},
		],
	};
}

describe("AgentResponseCache", () => {
	test("request fingerprint is deterministic and changes with semantic history", () => {
		const a = fingerprintChatRequest(body("ls"));
		const b = fingerprintChatRequest(body("ls"));
		const c = fingerprintChatRequest(body("pwd"));
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});

	test("cached tool call ids survive retries unchanged", () => {
		const cache = new AgentResponseCache(8, 10_000);
		const fingerprint = fingerprintChatRequest(body());
		cache.set(
			"deepseek-web",
			"explicit:task-1",
			fingerprint,
			{
				content: null,
				toolCalls: [
					{
						id: "call_gw_stable123",
						type: "function",
						function: { name: "exec", arguments: '{"command":"ls"}' },
					},
				],
				finishReason: "tool_calls",
				rawText: "canonical",
				promptText: "prompt",
			},
			100,
		);
		const first = cache.get("deepseek-web", "explicit:task-1", fingerprint, 200);
		const second = cache.get("deepseek-web", "explicit:task-1", fingerprint, 300);
		expect(first?.toolCalls?.[0]?.id).toBe("call_gw_stable123");
		expect(second?.toolCalls?.[0]?.id).toBe("call_gw_stable123");

		if (first?.toolCalls?.[0]) first.toolCalls[0].function.arguments = "mutated";
		expect(second?.toolCalls?.[0]?.function.arguments).toBe('{"command":"ls"}');
	});

	test("session deletion does not evict another logical session", () => {
		const cache = new AgentResponseCache(8, 10_000);
		const fingerprint = fingerprintChatRequest(body());
		const response = {
			content: "ok",
			toolCalls: undefined,
			finishReason: "stop" as const,
			rawText: "ok",
			promptText: "prompt",
		};
		cache.set("deepseek-web", "explicit:A", fingerprint, response, 100);
		cache.set("deepseek-web", "explicit:B", fingerprint, response, 100);
		expect(cache.deleteSession("deepseek-web", "explicit:A")).toBe(1);
		expect(cache.get("deepseek-web", "explicit:A", fingerprint, 200)).toBeUndefined();
		expect(cache.get("deepseek-web", "explicit:B", fingerprint, 200)?.content).toBe("ok");
	});
});
