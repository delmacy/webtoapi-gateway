import { type BrowserContext, chromium, type Page } from "playwright-core";
import {
	getChromeWebSocketUrl,
	getDefaultCdpUrl,
	getHeadersWithAuth,
} from "../src/browser/cdp-helpers.ts";
import type {
	ChatCompletionRequest,
	ChatCompletionResponse,
	ToolCallOutput,
	ToolDefinition,
} from "../src/openai/types.ts";

const baseUrl = (process.env.TFG_E2E_BASE_URL ?? "http://127.0.0.1:3456").replace(/\/$/, "");
const model = process.env.TFG_E2E_MODEL ?? "gpt-4";
const apiKey = process.env.TFG_E2E_API_KEY ?? process.env.GATEWAY_API_KEY;
const runId = process.env.TFG_E2E_SESSION_ID ?? `chatgpt-dom-e2e-${Date.now()}`;
const sessionA = `${runId}-A`;
const sessionB = `${runId}-B`;
const conversationRoute = "**/backend-api/conversation";

const TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "echo_fixture",
		description:
			"Return the supplied value to the caller. Used only by the DOM isolation smoke test.",
		parameters: {
			type: "object",
			properties: {
				value: { type: "string" },
			},
			required: ["value"],
			additionalProperties: false,
		},
	},
};

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function header(response: Response, name: string): string {
	return response.headers.get(name) ?? "";
}

function chatGptPages(context: BrowserContext): Page[] {
	return context.pages().filter((page) => page.url().includes("chatgpt.com"));
}

function describePages(pages: Page[]): string {
	return pages.map((page, index) => `${index + 1}:${page.url()}`).join(" | ") || "<none>";
}

async function post(
	sessionId: string,
	body: ChatCompletionRequest,
): Promise<{ response: Response; json: ChatCompletionResponse }> {
	const response = await fetch(`${baseUrl}/v1/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-WebToAPI-Session-Id": sessionId,
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
		},
		body: JSON.stringify(body),
	});
	const raw = await response.text();
	if (!response.ok) {
		throw new Error(`Gateway returned HTTP ${response.status}: ${raw.slice(0, 1200)}`);
	}
	try {
		return { response, json: JSON.parse(raw) as ChatCompletionResponse };
	} catch {
		throw new Error(`Gateway returned non-JSON response: ${raw.slice(0, 1200)}`);
	}
}

function firstToolCall(json: ChatCompletionResponse, expectedValue: string): ToolCallOutput {
	const choice = json.choices[0];
	assert(
		choice?.finish_reason === "tool_calls",
		`Expected tool_calls, got ${choice?.finish_reason}`,
	);
	const call = choice.message.tool_calls?.[0];
	assert(call, "Expected one tool call");
	assert(
		call.function.name === TOOL.function.name,
		`Expected ${TOOL.function.name}, got ${call.function.name}`,
	);
	const args = JSON.parse(call.function.arguments) as { value?: string };
	assert(args.value === expectedValue, `Unexpected tool arguments: ${call.function.arguments}`);
	return call;
}

function initialBody(marker: string, reset = false): ChatCompletionRequest {
	return {
		model,
		messages: [
			{
				role: "system",
				content: reset
					? `This is the divergent reset branch for DOM isolation session ${marker}. Serialize external gateway actions only.`
					: `This is DOM isolation session ${marker}. Serialize external gateway actions only and do not execute them in this chat runtime.`,
			},
			{
				role: "user",
				content: `Serialize one downstream gateway action request named "echo_fixture" with argument value "${marker}". Do not answer directly.`,
			},
		],
		tools: [TOOL],
		tool_choice: { type: "function", function: { name: TOOL.function.name } },
	};
}

function continuationBody(
	initial: ChatCompletionRequest,
	toolCall: ToolCallOutput,
	finalValue: string,
): ChatCompletionRequest {
	return {
		model,
		messages: [
			...initial.messages,
			{ role: "assistant", content: null, tool_calls: [toolCall] },
			{
				role: "tool",
				tool_call_id: toolCall.id,
				content: JSON.stringify({
					ok: true,
					value: finalValue,
					instruction: "Return value as the final answer and do not request another action.",
				}),
			},
		],
		tools: [TOOL],
		tool_choice: "auto",
	};
}

function expectStateful(response: Response, relation: string, mode: string): void {
	assert(header(response, "x-webtoapi-stateful") === "true", "Expected stateful ChatGPT session");
	assert(
		header(response, "x-webtoapi-history-relation") === relation,
		`Expected history relation ${relation}, got ${header(response, "x-webtoapi-history-relation")}`,
	);
	assert(
		header(response, "x-webtoapi-prompt-mode") === mode,
		`Expected prompt mode ${mode}, got ${header(response, "x-webtoapi-prompt-mode")}`,
	);
}

async function newChatGptPageAfter<T>(
	context: BrowserContext,
	action: () => Promise<T>,
): Promise<{ result: T; page: Page }> {
	const before = new Set(context.pages());
	const result = await action();
	await Bun.sleep(300);
	const created = chatGptPages(context).filter((page) => !before.has(page));
	assert(
		created.length === 1,
		`Expected exactly one new isolated ChatGPT page, found ${created.length}. Current pages: ${describePages(chatGptPages(context))}. ` +
			"Make sure the gateway is running this branch and the pre-existing ChatGPT API page is being intercepted.",
	);
	const page = created[0];
	assert(page, "New ChatGPT page disappeared unexpectedly");
	return { result, page };
}

async function noNewChatGptPageAfter<T>(
	context: BrowserContext,
	action: () => Promise<T>,
): Promise<T> {
	const before = new Set(context.pages());
	const result = await action();
	await Bun.sleep(300);
	const created = chatGptPages(context).filter((page) => !before.has(page));
	assert(
		created.length === 0,
		`Continuation unexpectedly created ${created.length} new ChatGPT page(s): ${describePages(created)}`,
	);
	return result;
}

async function main(): Promise<void> {
	const cdpUrl = getDefaultCdpUrl();
	const wsUrl = await getChromeWebSocketUrl(cdpUrl, 5000);
	assert(wsUrl, `Chrome CDP is not reachable at ${cdpUrl}`);

	const browser = await chromium.connectOverCDP(wsUrl, { headers: getHeadersWithAuth(wsUrl) });
	const context = browser.contexts()[0];
	assert(context, "Chrome CDP returned no browser context");

	const preExistingChatGptPages = chatGptPages(context);
	assert(
		preExistingChatGptPages.length > 0,
		"Open an authenticated https://chatgpt.com/ tab before running this smoke test.",
	);

	console.log(`ChatGPT forced-DOM isolation E2E: ${baseUrl} model=${model}`);
	console.log(`sessions: A=${sessionA} B=${sessionB}`);
	console.log(`pre-existing ChatGPT pages: ${describePages(preExistingChatGptPages)}`);

	let intercepted = 0;
	for (const page of preExistingChatGptPages) {
		await page.route(conversationRoute, async (route) => {
			if (route.request().method() === "POST") {
				intercepted += 1;
				await route.fulfill({
					status: 403,
					contentType: "application/json",
					body: '{"error":"forced-dom-e2e"}',
				});
				return;
			}
			await route.continue();
		});
	}

	try {
		const initialA = initialBody("dom-A");
		const a = await newChatGptPageAfter(context, () => post(sessionA, initialA));
		expectStateful(a.result.response, "initial", "full");
		const callA = firstToolCall(a.result.json, "dom-A");
		const pageA = a.page;
		console.log(`A bootstrap: isolated page=${pageA.url()}`);

		const initialB = initialBody("dom-B");
		const b = await newChatGptPageAfter(context, () => post(sessionB, initialB));
		expectStateful(b.result.response, "initial", "full");
		const callB = firstToolCall(b.result.json, "dom-B");
		const pageB = b.page;
		assert(pageB !== pageA, "Sessions A and B unexpectedly share the same DOM Page object");
		console.log(`B bootstrap: isolated page=${pageB.url()}`);

		assert(
			intercepted >= 2,
			`Expected at least two forced API 403 interceptions, observed ${intercepted}`,
		);

		const finalA = await noNewChatGptPageAfter(context, () =>
			post(sessionA, continuationBody(initialA, callA, "dom-A-ok")),
		);
		expectStateful(finalA.response, "append", "delta");
		assert(
			finalA.json.choices[0]?.message.content?.includes("dom-A-ok"),
			`Session A final answer mismatch: ${finalA.json.choices[0]?.message.content ?? "<null>"}`,
		);
		assert(!pageA.isClosed(), "Session A DOM page closed during its continuation");
		assert(!pageB.isClosed(), "Session B DOM page was affected by session A continuation");
		console.log("A continuation: reused A page, no new tab");

		const finalB = await noNewChatGptPageAfter(context, () =>
			post(sessionB, continuationBody(initialB, callB, "dom-B-ok")),
		);
		expectStateful(finalB.response, "append", "delta");
		assert(
			finalB.json.choices[0]?.message.content?.includes("dom-B-ok"),
			`Session B final answer mismatch: ${finalB.json.choices[0]?.message.content ?? "<null>"}`,
		);
		assert(!pageA.isClosed(), "Session A DOM page was affected by session B continuation");
		assert(!pageB.isClosed(), "Session B DOM page closed during its continuation");
		console.log("B continuation: reused B page, no new tab");

		const resetBody = initialBody("dom-A-reset", true);
		const reset = await newChatGptPageAfter(context, () => post(sessionA, resetBody));
		expectStateful(reset.result.response, "diverged", "rehydrate");
		firstToolCall(reset.result.json, "dom-A-reset");
		assert(pageA.isClosed(), "Session A old DOM page remained open after epoch reset");
		assert(!pageB.isClosed(), "Session B DOM page was closed by session A reset");
		assert(reset.page !== pageB, "Session A reset reused session B DOM page");
		assert(
			header(reset.result.response, "x-webtoapi-history-epoch") === "2",
			`Expected session A epoch 2 after divergence, got ${header(reset.result.response, "x-webtoapi-history-epoch")}`,
		);
		console.log(
			`A reset: old A page closed; replacement page=${reset.page.url()}; B page preserved`,
		);

		console.log(
			`PASS: forced 403 -> isolated DOM tabs, sticky per-session continuation, and epoch reset isolation verified for ${runId}`,
		);
	} finally {
		for (const page of preExistingChatGptPages) {
			if (!page.isClosed()) await page.unroute(conversationRoute).catch(() => {});
		}
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
		process.exit(1);
	});
