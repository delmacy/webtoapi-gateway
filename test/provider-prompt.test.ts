import { describe, expect, test } from "bun:test";
import type { ChatCompletionRequest, ToolDefinition } from "../src/openai/types.ts";
import { buildProviderPromptPlan } from "../src/session/provider-prompt.ts";
import { SessionEventStore } from "../src/session/store.ts";

const READ_TOOL: ToolDefinition = {
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
};

function baseBody(): ChatCompletionRequest {
	return {
		model: "deepseek-chat",
		messages: [{ role: "user", content: "Read package.json" }],
		tools: [READ_TOOL],
	};
}

describe("stateful provider prompt planning", () => {
	test("initial history bootstraps a fresh provider thread with full prompt", () => {
		const store = new SessionEventStore();
		const body = baseBody();
		const reconciliation = store.reconcile("s1", body.messages, body.tools);
		const plan = buildProviderPromptPlan(body, reconciliation, {
			compactTools: true,
			statefulEligible: true,
		});
		expect(plan.mode).toBe("full");
		expect(plan.statefulSession).toBe(true);
		expect(plan.resetSession).toBe(true);
		expect(plan.prompt).toContain("Read package.json");
		expect(plan.prompt).toContain("External action catalog:");
		expect(plan.prompt).toContain("external metadata");
		expect(plan.prompt).toContain("do NOT execute it here");
		expect(plan.prompt).toContain("downstream gateway");
	});

	test("append after a tool call sends only the real tool result, not assistant echo", () => {
		const store = new SessionEventStore();
		const initial = baseBody();
		store.reconcile("s1", initial.messages, initial.tools);
		const body: ChatCompletionRequest = {
			...initial,
			messages: [
				...initial.messages,
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "read", arguments: '{"path":"package.json"}' },
						},
					],
				},
				{ role: "tool", tool_call_id: "call_1", content: '{"name":"gateway"}' },
			],
		};
		const reconciliation = store.reconcile("s1", body.messages, body.tools);
		const plan = buildProviderPromptPlan(body, reconciliation, {
			compactTools: true,
			statefulEligible: true,
		});
		expect(reconciliation.relation).toBe("append");
		expect(plan.mode).toBe("delta");
		expect(plan.resetSession).toBe(false);
		expect(plan.deltaMessages).toBe(1);
		expect(plan.prompt).toContain("<tool_result");
		expect(plan.prompt).toContain('{"name":"gateway"}');
		expect(plan.prompt).not.toContain("Human: Read package.json");
		expect(plan.prompt).not.toContain("[Called tools]");
		expect(plan.prompt).not.toContain("External action catalog:");
		expect(plan.prompt).toContain("continuation");
	});

	test("tool registry changes are resent with the append delta", () => {
		const store = new SessionEventStore();
		const initial = baseBody();
		store.reconcile("s1", initial.messages, initial.tools);
		const extraTool: ToolDefinition = {
			type: "function",
			function: {
				name: "exec",
				parameters: { type: "object", properties: { command: { type: "string" } } },
			},
		};
		const body: ChatCompletionRequest = {
			...initial,
			tools: [READ_TOOL, extraTool],
			messages: [...initial.messages, { role: "user", content: "Now inspect scripts" }],
		};
		const reconciliation = store.reconcile("s1", body.messages, body.tools);
		const plan = buildProviderPromptPlan(body, reconciliation, {
			compactTools: true,
			statefulEligible: true,
		});
		expect(plan.mode).toBe("delta");
		expect(reconciliation.toolRegistryChanged).toBe(true);
		expect(plan.prompt).toContain("External action catalog:");
		expect(plan.prompt).toContain('"exec"');
		expect(plan.prompt).not.toContain("Human: Read package.json");
	});

	test("exact retry and divergence request fresh-thread rehydration", () => {
		const store = new SessionEventStore();
		const body = baseBody();
		store.reconcile("s1", body.messages, body.tools);
		const retry = store.reconcile("s1", body.messages, body.tools);
		const retryPlan = buildProviderPromptPlan(body, retry, {
			compactTools: true,
			statefulEligible: true,
		});
		expect(retryPlan.mode).toBe("retry-rehydrate");
		expect(retryPlan.resetSession).toBe(true);

		const divergedBody: ChatCompletionRequest = {
			...body,
			messages: [{ role: "user", content: "Different branch" }],
		};
		const diverged = store.reconcile("s1", divergedBody.messages, divergedBody.tools);
		const divergedPlan = buildProviderPromptPlan(divergedBody, diverged, {
			compactTools: true,
			statefulEligible: true,
		});
		expect(diverged.relation).toBe("diverged");
		expect(divergedPlan.mode).toBe("rehydrate");
		expect(divergedPlan.resetSession).toBe(true);
	});

	test("oversized exact retry rehydrates from a bounded recent suffix", () => {
		const store = new SessionEventStore();
		const body: ChatCompletionRequest = {
			model: "deepseek-chat",
			tools: [READ_TOOL],
			messages: [
				{ role: "system", content: "KEEP-SYSTEM-INSTRUCTION" },
				{ role: "user", content: `OLD-HISTORY-${"x".repeat(12_000)}` },
				{ role: "assistant", content: `OLD-ANSWER-${"y".repeat(12_000)}` },
				{ role: "user", content: "LATEST-REQUEST" },
			],
		};
		store.reconcile("s-large", body.messages, body.tools);
		const retry = store.reconcile("s-large", body.messages, body.tools);
		const plan = buildProviderPromptPlan(body, retry, {
			compactTools: true,
			statefulEligible: true,
			rehydrationMaxChars: 8_192,
		});
		expect(plan.mode).toBe("retry-rehydrate");
		expect(plan.prompt.length).toBeLessThanOrEqual(8_192);
		expect(plan.prompt).toContain("KEEP-SYSTEM-INSTRUCTION");
		expect(plan.prompt).toContain("LATEST-REQUEST");
		expect(plan.prompt).not.toContain("OLD-HISTORY-");
		expect(plan.prompt).not.toContain("OLD-ANSWER-");
		expect(plan.rehydrationOmittedMessages).toBe(2);
	});

	test("delta plan keeps a bounded fallback rehydration prompt", () => {
		const store = new SessionEventStore();
		const initial: ChatCompletionRequest = {
			model: "deepseek-chat",
			tools: [READ_TOOL],
			messages: [
				{ role: "system", content: "KEEP-SYSTEM" },
				{ role: "user", content: `OLD-${"z".repeat(12_000)}` },
			],
		};
		store.reconcile("s-fallback", initial.messages, initial.tools);
		const body: ChatCompletionRequest = {
			...initial,
			messages: [...initial.messages, { role: "user", content: "NEW-DELTA" }],
		};
		const append = store.reconcile("s-fallback", body.messages, body.tools);
		const plan = buildProviderPromptPlan(body, append, {
			compactTools: true,
			statefulEligible: true,
			rehydrationMaxChars: 8_192,
		});
		expect(plan.mode).toBe("delta");
		expect(plan.prompt).toContain("NEW-DELTA");
		expect(plan.fullPrompt.length).toBeLessThanOrEqual(8_192);
		expect(plan.fullPrompt).toContain("KEEP-SYSTEM");
		expect(plan.fullPrompt).toContain("NEW-DELTA");
		expect(plan.fullPrompt).not.toContain("OLD-");
		expect(plan.rehydrationOmittedMessages).toBe(1);
	});

	test("unstable sessions remain full-prompt and stateless", () => {
		const store = new SessionEventStore();
		const body = baseBody();
		const reconciliation = store.reconcile("auto:test", body.messages, body.tools);
		const plan = buildProviderPromptPlan(body, reconciliation, {
			compactTools: true,
			statefulEligible: false,
		});
		expect(plan.statefulSession).toBe(false);
		expect(plan.mode).toBe("full");
		expect(plan.prompt).toContain("Human: Read package.json");
	});
});