import { describe, expect, test } from "bun:test";
import { AgentRuntime } from "../src/agent/runtime.ts";
import type { ChatCompletionRequest } from "../src/openai/types.ts";

function runtime() {
	return new AgentRuntime({
		mode: "optimized",
		sessionIdleTtlSec: 3600,
		maxToolTurns: 40,
		maxIdenticalToolCalls: 2,
		toolResultMaxChars: 12_000,
		preserveTailMessages: 6,
		telemetry: false,
	});
}

function request(extra: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
	return {
		model: "deepseek-chat",
		messages: [{ role: "user", content: "Implement task" }],
		...extra,
	};
}

describe("agent session identity", () => {
	test("header-style override is explicit and stable", () => {
		const result = runtime().optimize(request(), "task-123");
		expect(result.sessionId).toBe("explicit:task-123");
		expect(result.sessionIdSource).toBe("override");
		expect(result.sessionStable).toBe(true);
	});

	test("body extension creates an explicit stable session", () => {
		const result = runtime().optimize(request({ webtoapi_session_id: "body-123" }));
		expect(result.sessionId).toBe("explicit:body-123");
		expect(result.sessionIdSource).toBe("body");
		expect(result.sessionStable).toBe(true);
	});

	test("OpenAI user field remains a stable logical session key", () => {
		const result = runtime().optimize(request({ user: "opencode-task-7" }));
		expect(result.sessionId).toBe("user:opencode-task-7");
		expect(result.sessionIdSource).toBe("user");
		expect(result.sessionStable).toBe(true);
	});

	test("derived auto ids are intentionally marked unsafe for upstream affinity", () => {
		const first = runtime().optimize(request());
		const second = runtime().optimize(request());
		expect(first.sessionId).toBe(second.sessionId);
		expect(first.sessionIdSource).toBe("auto");
		expect(first.sessionStable).toBe(false);
	});
});
