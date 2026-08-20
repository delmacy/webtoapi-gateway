import { describe, expect, test } from "bun:test";
import { normalizeBrowserCookie } from "../src/browser/manager.ts";

describe("browser cookie normalization", () => {
	test("preserves ordinary domain cookies", () => {
		expect(
			normalizeBrowserCookie({
				name: "session",
				value: "abc",
				domain: ".chatgpt.com",
				path: "/",
			}),
		).toEqual({
			name: "session",
			value: "abc",
			domain: ".chatgpt.com",
			path: "/",
			secure: false,
		});
	});

	test("forces Secure for __Secure- cookies", () => {
		const cookie = normalizeBrowserCookie({
			name: "__Secure-next-auth.session-token",
			value: "token",
			domain: ".chatgpt.com",
			path: "/",
		});
		expect(cookie.secure).toBe(true);
		expect(cookie.domain).toBe(".chatgpt.com");
	});

	test("uses a host-only secure URL for __Host- cookies", () => {
		expect(
			normalizeBrowserCookie({
				name: "__Host-next-auth.csrf-token",
				value: "csrf",
				domain: ".chatgpt.com",
				path: "/",
			}),
		).toEqual({
			name: "__Host-next-auth.csrf-token",
			value: "csrf",
			url: "https://chatgpt.com/",
			secure: true,
		});
	});
});
