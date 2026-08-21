import { describe, expect, test } from "bun:test";
import webToAPIOpenCodePlugin from "../integrations/opencode/plugin.ts";

describe("OpenCode WebToAPI plugin", () => {
	test("registers the tested WebToAPI models and durable compaction defaults", async () => {
		const hooks = await webToAPIOpenCodePlugin(
			{ directory: ".", worktree: ".", serverUrl: new URL("http://localhost") },
			{},
		);
		const config: Record<string, any> = {};
		await hooks.config?.(config);

		expect(config.provider.webtoapi.npm).toBe("@ai-sdk/openai-compatible");
		expect(config.provider.webtoapi.options.baseURL).toBe("http://127.0.0.1:3456/v1");
		expect(Object.keys(config.provider.webtoapi.models).sort()).toEqual(
			["deepseek-chat", "gpt-4", "moonshot-v1-32k", "qwen3.5-plus"].sort(),
		);
		expect(config.compaction.auto).toBe(true);
		expect(config.compaction.prune).toBe(true);
		expect(config.compaction.tail_turns).toBe(15);
	});

	test("preserves explicit user config while filling provider defaults", async () => {
		const hooks = await webToAPIOpenCodePlugin(
			{ directory: ".", worktree: ".", serverUrl: new URL("http://localhost") },
			{ baseURL: "http://gateway.test/v1", tailTurns: 9 },
		);
		const config: Record<string, any> = {
			provider: {
				webtoapi: {
					name: "Custom Gateway",
					models: { "custom-model": { name: "Custom" } },
				},
			},
			compaction: { auto: false },
		};
		await hooks.config?.(config);

		expect(config.provider.webtoapi.name).toBe("Custom Gateway");
		expect(config.provider.webtoapi.options.baseURL).toBe("http://gateway.test/v1");
		expect(config.provider.webtoapi.models["custom-model"]).toEqual({ name: "Custom" });
		expect(config.compaction.auto).toBe(false);
		expect(config.compaction.tail_turns).toBe(9);
	});

	test("sends the canonical gateway session id for WebToAPI only", async () => {
		const hooks = await webToAPIOpenCodePlugin(
			{ directory: ".", worktree: ".", serverUrl: new URL("http://localhost") },
			{},
		);
		const output = { headers: {} as Record<string, string> };
		await hooks["chat.headers"]?.(
			{
				sessionID: "ses_test",
				agent: "build",
				model: { providerID: "webtoapi", id: "deepseek-chat" },
				provider: { info: { id: "webtoapi" } },
				message: { id: "msg_test" },
			},
			output,
		);

		expect(output.headers["x-webtoapi-session-id"]).toBe("ses_test");
		expect(output.headers["x-webtoapi-request-id"]).toBe("msg_test");
		expect(output.headers["x-webtoapi-client"]).toBe("opencode-plugin");
	});

	test("adds durable system and compaction continuity context", async () => {
		const hooks = await webToAPIOpenCodePlugin(
			{ directory: ".", worktree: ".", serverUrl: new URL("http://localhost") },
			{},
		);
		const system = { system: ["base"] };
		await hooks["experimental.chat.system.transform"]?.(
			{ sessionID: "ses_test", model: { providerID: "webtoapi" } },
			system,
		);
		expect(system.system.join("\n")).toContain("durable execution rules");

		const compacting = { context: [] as string[], prompt: undefined as string | undefined };
		await hooks["experimental.session.compacting"]?.({ sessionID: "ses_test" }, compacting);
		expect(compacting.context.join("\n")).toContain("durable execution checkpoint");
		expect(compacting.context.join("\n")).toContain("exact next action");

		const autocontinue = { enabled: false };
		await hooks["experimental.compaction.autocontinue"]?.(
			{
				sessionID: "ses_test",
				model: { providerID: "webtoapi" },
				provider: { info: { id: "webtoapi" } },
			},
			autocontinue,
		);
		expect(autocontinue.enabled).toBe(true);
	});
});
