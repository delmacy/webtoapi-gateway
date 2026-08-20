import { describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { watchProviderNavigation } from "../src/providers/discovery.ts";

describe("provider navigation discovery", () => {
	test("registers domcontentloaded listener only once per page", () => {
		let listeners = 0;
		const page = {
			url: () => "about:blank",
			on: (event: string) => {
				if (event === "domcontentloaded") listeners += 1;
				return page;
			},
		} as unknown as Page;

		watchProviderNavigation(page);
		watchProviderNavigation(page);

		expect(listeners).toBe(1);
	});
});
