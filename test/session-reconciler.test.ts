import { describe, expect, test } from "bun:test";
import type { ChatMessage, ToolDefinition } from "../src/openai/types.ts";
import {
	normalizeOpenAiMessages,
	semanticHash,
	snapshotToolRegistry,
	stableJson,
} from "../src/session/canonical.ts";
import { reconcileCanonicalHistory } from "../src/session/reconciler.ts";
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

const EXEC_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "exec",
		description: "Run a command",
		parameters: {
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
		},
	},
};

function messages(...contents: string[]): ChatMessage[] {
	return contents.map((content, index) => ({
		role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
		content,
	}));
}

describe("canonical event normalization", () => {
	test("stable JSON and hashes ignore object key order", () => {
		expect(stableJson({ b: 2, a: { y: 2, x: 1 } })).toBe(
			stableJson({ a: { x: 1, y: 2 }, b: 2 }),
		);
		expect(semanticHash({ b: 2, a: 1 })).toBe(semanticHash({ a: 1, b: 2 }));
	});

	test("splits assistant tool calls and tool results into correlated events", () => {
		const source: ChatMessage[] = [
			{ role: "system", content: "Follow repository rules" },
			{ role: "user", content: "Read package.json" },
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
			{ role: "tool", tool_call_id: "call_1", content: '{"version":"1.0.0"}' },
			{ role: "assistant", content: "Version is 1.0.0" },
		];
		const events = normalizeOpenAiMessages(source);
		expect(events.map((event) => event.kind)).toEqual([
			"system_instruction",
			"user_message",
			"tool_call",
			"tool_result",
			"assistant_message",
		]);
		expect(events[2]?.payload.callId).toBe("call_1");
		expect(events[3]?.payload.callId).toBe("call_1");
		expect(events[2]?.payload.arguments).toEqual({ path: "package.json" });
	});

	test("tool registry hash is independent of tool ordering", () => {
		const a = snapshotToolRegistry([READ_TOOL, EXEC_TOOL]);
		const b = snapshotToolRegistry([EXEC_TOOL, READ_TOOL]);
		expect(a?.hash).toBe(b?.hash);
		expect(a?.names).toEqual(["exec", "read"]);
	});
});

describe("history reconciliation", () => {
	test("initial history bootstraps every event", () => {
		const incoming = normalizeOpenAiMessages(messages("A", "B"));
		const result = reconcileCanonicalHistory([], incoming);
		expect(result.relation).toBe("initial");
		expect(result.action).toBe("bootstrap");
		expect(result.deltaEvents).toHaveLength(2);
		expect(result.requiresRehydrate).toBe(false);
	});

	test("exact retry produces no delta", () => {
		const previous = normalizeOpenAiMessages(messages("A", "B", "C"));
		const incoming = normalizeOpenAiMessages(messages("A", "B", "C"));
		const result = reconcileCanonicalHistory(previous, incoming);
		expect(result.relation).toBe("exact");
		expect(result.action).toBe("noop");
		expect(result.commonPrefixEvents).toBe(3);
		expect(result.deltaEvents).toEqual([]);
	});

	test("append-only history returns only the new suffix", () => {
		const previous = normalizeOpenAiMessages(messages("A", "B", "C"));
		const incoming = normalizeOpenAiMessages(messages("A", "B", "C", "D", "E"));
		const result = reconcileCanonicalHistory(previous, incoming);
		expect(result.relation).toBe("append");
		expect(result.action).toBe("append");
		expect(result.commonPrefixEvents).toBe(3);
		expect(result.deltaEvents.map((event) => event.payload.content)).toEqual(["D", "E"]);
		expect(result.requiresRehydrate).toBe(false);
	});

	test("rewind requires provider rehydration", () => {
		const previous = normalizeOpenAiMessages(messages("A", "B", "C"));
		const incoming = normalizeOpenAiMessages(messages("A", "B"));
		const result = reconcileCanonicalHistory(previous, incoming);
		expect(result.relation).toBe("rewind");
		expect(result.action).toBe("rehydrate");
		expect(result.divergenceAt).toBe(2);
		expect(result.requiresRehydrate).toBe(true);
	});

	test("branch divergence reports the exact divergence point", () => {
		const previous = normalizeOpenAiMessages(messages("A", "B", "C"));
		const incoming = normalizeOpenAiMessages(messages("A", "B", "X", "Y"));
		const result = reconcileCanonicalHistory(previous, incoming);
		expect(result.relation).toBe("diverged");
		expect(result.action).toBe("rehydrate");
		expect(result.commonPrefixEvents).toBe(2);
		expect(result.divergenceAt).toBe(2);
		expect(result.deltaEvents).toHaveLength(4);
	});
});

describe("session event store", () => {
	test("keeps epoch stable for retry/append and increments it on divergence", () => {
		const store = new SessionEventStore();
		const initial = store.reconcile("s1", messages("A", "B"), [READ_TOOL], 100);
		const retry = store.reconcile("s1", messages("A", "B"), [READ_TOOL], 200);
		const append = store.reconcile("s1", messages("A", "B", "C"), [READ_TOOL], 300);
		const diverged = store.reconcile("s1", messages("A", "X"), [READ_TOOL], 400);

		expect(initial.epoch).toBe(1);
		expect(retry.epoch).toBe(1);
		expect(append.epoch).toBe(1);
		expect(diverged.epoch).toBe(2);
		expect(diverged.requiresRehydrate).toBe(true);
		expect(store.get("s1")?.events.map((event) => event.payload.content)).toEqual(["A", "X"]);
	});

	test("detects tool registry changes independently from message history", () => {
		const store = new SessionEventStore();
		const initial = store.reconcile("s1", messages("A"), [READ_TOOL]);
		const same = store.reconcile("s1", messages("A"), [READ_TOOL]);
		const changed = store.reconcile("s1", messages("A"), [READ_TOOL, EXEC_TOOL]);

		expect(initial.toolRegistryChanged).toBe(true);
		expect(same.toolRegistryChanged).toBe(false);
		expect(changed.toolRegistryChanged).toBe(true);
		expect(changed.relation).toBe("exact");
	});

	test("cleans up idle session histories", () => {
		const store = new SessionEventStore();
		store.reconcile("old", messages("A"), undefined, 100);
		store.reconcile("new", messages("B"), undefined, 500);
		expect(store.cleanupBefore(300)).toBe(1);
		expect(store.get("old")).toBeUndefined();
		expect(store.get("new")).toBeDefined();
	});
});
