import { describe, expect, test } from "bun:test";
import { AgentRuntime } from "../src/agent/runtime.ts";
import type { ChatCompletionRequest } from "../src/openai/types.ts";

function runtime(mode: "optimized" | "passthrough" = "optimized") {
	return new AgentRuntime({
		mode,
		sessionIdleTtlSec: 3600,
		maxToolTurns: 3,
		maxIdenticalToolCalls: 2,
		toolResultMaxChars: 300,
		preserveTailMessages: 2,
		telemetry: false,
	});
}

describe("AgentRuntime", () => {
	test("compacts only historical oversized tool results", () => {
		const body: ChatCompletionRequest = {
			model: "qwen-test",
			messages: [
				{ role: "user", content: "inspect files" },
				{ role: "tool", tool_call_id: "old", content: "x".repeat(2000) },
				{ role: "assistant", content: "continuing" },
				{ role: "tool", tool_call_id: "recent", content: "y".repeat(2000) },
			],
		};
		const r = runtime();
		const result = r.optimize(body);
		const oldTool = result.body.messages[1];
		const recentTool = result.body.messages[3];
		expect(oldTool?.role).toBe("tool");
		expect(oldTool?.role === "tool" ? oldTool.content.length : 9999).toBeLessThan(1000);
		expect(oldTool?.role === "tool" ? oldTool.content : "").toContain("context compaction");
		expect(recentTool?.role === "tool" ? recentTool.content.length : 0).toBe(2000);
		expect(result.snapshot.savedPromptChars).toBeGreaterThan(0);

		const canonicalOldTool = r
			.getHistorySnapshot(result.sessionId)
			?.events.find((event) => event.kind === "tool_result" && event.payload.callId === "old");
		expect(String(canonicalOldTool?.payload.content ?? "").length).toBe(2000);
	});

	test("derives a stable session id and append delta for repeated task context", () => {
		const base: ChatCompletionRequest = {
			model: "kimi-test",
			messages: [{ role: "user", content: "TASK-123 implement feature" }],
		};
		const r = runtime();
		const a = r.optimize(base);
		const b = r.optimize({
			...base,
			messages: [...base.messages, { role: "assistant", content: "ok" }],
		});
		expect(a.sessionId).toBe(b.sessionId);
		expect(a.reconciliation.relation).toBe("initial");
		expect(b.reconciliation.relation).toBe("append");
		expect(b.reconciliation.deltaEvents).toHaveLength(1);
		expect(b.snapshot.requests).toBe(2);
		expect(b.snapshot.historyEpoch).toBe(1);
	});

	test("detects exact retry without producing a semantic delta", () => {
		const body: ChatCompletionRequest = {
			model: "qwen-test",
			messages: [
				{ role: "user", content: "inspect" },
				{ role: "assistant", content: "done" },
			],
		};
		const r = runtime();
		r.optimize(body);
		const retry = r.optimize(body);
		expect(retry.reconciliation.relation).toBe("exact");
		expect(retry.reconciliation.action).toBe("noop");
		expect(retry.snapshot.deltaEvents).toBe(0);
		expect(retry.snapshot.requiresRehydrate).toBe(false);
	});

	test("increments history epoch when a session diverges", () => {
		const r = runtime();
		const initial: ChatCompletionRequest = {
			model: "deepseek-test",
			messages: [
				{ role: "user", content: "task" },
				{ role: "assistant", content: "path A" },
			],
		};
		const a = r.optimize(initial);
		const b = r.optimize({
			...initial,
			messages: [
				{ role: "user", content: "task" },
				{ role: "assistant", content: "path B" },
			],
		});
		expect(a.snapshot.historyEpoch).toBe(1);
		expect(b.reconciliation.relation).toBe("diverged");
		expect(b.reconciliation.action).toBe("rehydrate");
		expect(b.snapshot.historyEpoch).toBe(2);
		expect(b.snapshot.requiresRehydrate).toBe(true);
	});

	test("stops runaway identical tool calls", () => {
		const body: ChatCompletionRequest = {
			model: "deepseek-test",
			messages: [
				{ role: "user", content: "read file" },
				...Array.from({ length: 3 }, (_, i) => ({
					role: "assistant" as const,
					tool_calls: [
						{
							id: `call_${i}`,
							type: "function" as const,
							function: { name: "read", arguments: '{"filePath":"a.ts"}' },
						},
					],
				})),
			],
		};
		const result = runtime().optimize(body);
		expect(result.rejection?.status).toBe(409);
		expect(result.rejection?.message).toContain("identical tool call");
	});

	test("passthrough does not compact or reject agent loops", () => {
		const longResult = "z".repeat(2000);
		const body: ChatCompletionRequest = {
			model: "qwen-test",
			messages: [
				{ role: "user", content: "repeat read" },
				{ role: "tool", tool_call_id: "old", content: longResult },
				...Array.from({ length: 4 }, (_, i) => ({
					role: "assistant" as const,
					tool_calls: [
						{
							id: `call_${i}`,
							type: "function" as const,
							function: { name: "read", arguments: '{"filePath":"a.ts"}' },
						},
					],
				})),
			],
		};
		const result = runtime("passthrough").optimize(body);
		expect(result.rejection).toBeUndefined();
		expect(result.body).toBe(body);
		expect(result.body.messages[1]?.role === "tool" ? result.body.messages[1].content : "").toBe(
			longResult,
		);
	});
});
