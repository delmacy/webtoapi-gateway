import { afterEach, describe, expect, test } from "bun:test";
import {
	clearChatGptModelCooldowns,
	getChatGptModelCooldown,
	parseChatGptModelCap,
	recordChatGptModelCooldown,
} from "../src/providers/chatgpt/rate-limit.ts";

afterEach(() => {
	clearChatGptModelCooldowns();
});

describe("ChatGPT model cap cooldown", () => {
	test("parses model_cap_exceeded and authoritative clears_in", () => {
		const parsed = parseChatGptModelCap(
			JSON.stringify({
				detail: {
					message: "You have sent too many messages to the model. Please try again later.",
					code: "model_cap_exceeded",
					clears_in: 4765,
				},
			}),
		);

		expect(parsed).toEqual({ code: "model_cap_exceeded", retryAfterSeconds: 4765 });
	});

	test("ignores unrelated or malformed 429 payloads", () => {
		expect(parseChatGptModelCap("not-json")).toBeNull();
		expect(
			parseChatGptModelCap(
				JSON.stringify({ detail: { code: "rate_limit_exceeded", clears_in: 10 } }),
			),
		).toBeNull();
		expect(
			parseChatGptModelCap(
				JSON.stringify({ detail: { code: "model_cap_exceeded", clears_in: 0 } }),
			),
		).toBeNull();
	});

	test("keeps cooldown scoped to the affected model", () => {
		const now = 1_000_000;
		recordChatGptModelCooldown("gpt-4", 120, now);

		expect(getChatGptModelCooldown("gpt-4", now)).toBe(120);
		expect(getChatGptModelCooldown("gpt-4", now + 30_001)).toBe(90);
		expect(getChatGptModelCooldown("gpt-4-turbo", now)).toBeNull();
	});

	test("expires cooldown deterministically instead of blocking forever", () => {
		const now = 5_000;
		recordChatGptModelCooldown("gpt-4", 2, now);

		expect(getChatGptModelCooldown("gpt-4", now + 1_999)).toBe(1);
		expect(getChatGptModelCooldown("gpt-4", now + 2_000)).toBeNull();
		expect(getChatGptModelCooldown("gpt-4", now + 3_000)).toBeNull();
	});
});
