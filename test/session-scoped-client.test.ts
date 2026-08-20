import { describe, expect, test } from "bun:test";
import { SessionScopedProviderClient } from "../src/providers/session-scoped-client.ts";
import type {
	ProviderSendParams,
	StreamResult,
	WebProviderClient,
} from "../src/providers/types.ts";

function textStream(text: string): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
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

type InnerRecord = {
	id: number;
	initCount: number;
	closeCount: number;
	sends: ProviderSendParams[];
};

function createHarness() {
	let nextId = 0;
	const records: InnerRecord[] = [];
	const factory = (): WebProviderClient => {
		const record: InnerRecord = {
			id: ++nextId,
			initCount: 0,
			closeCount: 0,
			sends: [],
		};
		records.push(record);
		return {
			providerId: "inner",
			async init() {
				record.initCount += 1;
			},
			async sendMessage(params) {
				record.sends.push({ ...params });
				return textStream(`client-${record.id}:${params.message}`);
			},
			async parseStream(body, onDelta): Promise<StreamResult> {
				const text = await readStream(body);
				onDelta?.(text);
				return { text, thinkingText: "" };
			},
			listModels: () => [{ id: "m", name: "M" }],
			async close() {
				record.closeCount += 1;
			},
		};
	};
	const wrapper = new SessionScopedProviderClient(
		"deepseek-web",
		[{ id: "m", name: "M" }],
		{},
		factory,
		{ persistentConversation: true, deltaPrompts: true, resettable: true },
	);
	return { wrapper, records };
}

async function roundTrip(wrapper: SessionScopedProviderClient, params: ProviderSendParams) {
	const stream = await wrapper.sendMessage(params);
	return wrapper.parseStream(stream);
}

describe("SessionScopedProviderClient", () => {
	test("reuses one inner adapter for the same logical session and epoch", async () => {
		const { wrapper, records } = createHarness();
		await roundTrip(wrapper, {
			message: "one",
			statefulSession: true,
			sessionId: "s1",
			sessionEpoch: 1,
		});
		await roundTrip(wrapper, {
			message: "two",
			statefulSession: true,
			sessionId: "s1",
			sessionEpoch: 1,
		});
		expect(records).toHaveLength(1);
		expect(records[0]?.sends.map((send) => send.message)).toEqual(["one", "two"]);
	});

	test("isolates two logical sessions into different provider adapters", async () => {
		const { wrapper, records } = createHarness();
		await roundTrip(wrapper, {
			message: "A",
			statefulSession: true,
			sessionId: "session-A",
			sessionEpoch: 1,
		});
		await roundTrip(wrapper, {
			message: "B",
			statefulSession: true,
			sessionId: "session-B",
			sessionEpoch: 1,
		});
		expect(records).toHaveLength(2);
		expect(records[0]?.sends[0]?.message).toBe("A");
		expect(records[1]?.sends[0]?.message).toBe("B");
	});

	test("epoch change or explicit reset replaces the inner adapter", async () => {
		const { wrapper, records } = createHarness();
		await roundTrip(wrapper, {
			message: "epoch-1",
			statefulSession: true,
			sessionId: "s1",
			sessionEpoch: 1,
		});
		await roundTrip(wrapper, {
			message: "epoch-2",
			statefulSession: true,
			sessionId: "s1",
			sessionEpoch: 2,
		});
		await roundTrip(wrapper, {
			message: "reset",
			statefulSession: true,
			sessionId: "s1",
			sessionEpoch: 2,
			resetSession: true,
		});
		expect(records).toHaveLength(3);
		expect(records[0]?.closeCount).toBe(1);
		expect(records[1]?.closeCount).toBe(1);
	});

	test("stateless requests use ephemeral adapters and close after parsing", async () => {
		const { wrapper, records } = createHarness();
		await roundTrip(wrapper, { message: "one" });
		await roundTrip(wrapper, { message: "two" });
		expect(records).toHaveLength(2);
		expect(records.every((record) => record.closeCount === 1)).toBe(true);
	});
});
