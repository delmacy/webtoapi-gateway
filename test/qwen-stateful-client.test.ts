import { describe, expect, test } from "bun:test";
import { QwenWebClient } from "../src/providers/qwen/client.ts";

const credentials = {
	sessionToken: "test-session",
	cookie: "qwen_session=test-session",
	userAgent: "test-user-agent",
};

describe("QwenWebClient stateful shape", () => {
	test("keeps provider identity and model catalog", () => {
		const client = new QwenWebClient(credentials);
		expect(client.providerId).toBe("qwen-web");
		expect(client.listModels().map((model) => model.id)).toContain("qwen3.5-plus");
	});
});
