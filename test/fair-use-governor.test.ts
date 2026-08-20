import { describe, expect, test } from "bun:test";
import { FairUseGovernor } from "../src/agent/governor.ts";

describe("FairUseGovernor", () => {
	test("serializes requests when maxConcurrency is 1", async () => {
		const governor = new FairUseGovernor();
		const releaseFirst = await governor.acquire("qwen-web", {
			maxConcurrency: 1,
			minIntervalMs: 0,
		});

		let secondAcquired = false;
		const second = governor
			.acquire("qwen-web", { maxConcurrency: 1, minIntervalMs: 0 })
			.then((release) => {
				secondAcquired = true;
				return release;
			});

		await Promise.resolve();
		expect(secondAcquired).toBe(false);
		expect(governor.getStats("qwen-web").queued).toBe(1);

		releaseFirst();
		const releaseSecond = await second;
		expect(secondAcquired).toBe(true);
		expect(governor.getStats("qwen-web").active).toBe(1);
		releaseSecond();
	});

	test("keeps provider queues independent", async () => {
		const governor = new FairUseGovernor();
		const releaseQwen = await governor.acquire("qwen-web", { maxConcurrency: 1, minIntervalMs: 0 });
		const releaseKimi = await governor.acquire("kimi-web", { maxConcurrency: 1, minIntervalMs: 0 });
		expect(governor.getStats("qwen-web").active).toBe(1);
		expect(governor.getStats("kimi-web").active).toBe(1);
		releaseQwen();
		releaseKimi();
	});
});
