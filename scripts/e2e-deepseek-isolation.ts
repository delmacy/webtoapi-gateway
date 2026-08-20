import type {
	ChatCompletionRequest,
	ChatCompletionResponse,
	ToolCallOutput,
	ToolDefinition,
} from "../src/openai/types.ts";

const baseUrl = (process.env.TFG_E2E_BASE_URL ?? "http://127.0.0.1:3456").replace(/\/$/, "");
const model = process.env.TFG_E2E_MODEL ?? "deepseek-chat";
const apiKey = process.env.TFG_E2E_API_KEY ?? process.env.GATEWAY_API_KEY;
const runId = process.env.TFG_E2E_SESSION_ID ?? `deepseek-isolation-e2e-${Date.now()}`;
const sessionA = `${runId}-A`;
const sessionB = `${runId}-B`;

const TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "echo_fixture",
		description: "Return the supplied value to the caller for a DeepSeek session isolation smoke test.",
		parameters: {
			type: "object",
			properties: { value: { type: "string" } },
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
	if (!response.ok) throw new Error(`Gateway HTTP ${response.status}: ${raw.slice(0, 1200)}`);
	try {
		return { response, json: JSON.parse(raw) as ChatCompletionResponse };
	} catch {
		throw new Error(`Gateway returned non-JSON response: ${raw.slice(0, 1200)}`);
	}
}

function expectStateful(response: Response, relation: string, mode: string): void {
	assert(header(response, "x-webtoapi-session-source") === "override", "Expected override session source");
	assert(header(response, "x-webtoapi-stateful") === "true", "Expected stateful DeepSeek session");
	assert(
		header(response, "x-webtoapi-history-relation") === relation,
		`Expected relation ${relation}, got ${header(response, "x-webtoapi-history-relation")}`,
	);
	assert(
		header(response, "x-webtoapi-prompt-mode") === mode,
		`Expected mode ${mode}, got ${header(response, "x-webtoapi-prompt-mode")}`,
	);
}

function initialBody(marker: string, reset = false): ChatCompletionRequest {
	return {
		model,
		messages: [
			{
				role: "system",
				content: reset
					? `This is a divergent reset branch for isolated DeepSeek session ${marker}. Serialize external gateway actions only.`
					: `This is isolated DeepSeek session ${marker}. Serialize external gateway actions only; do not execute them locally.`,
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

function firstToolCall(json: ChatCompletionResponse, expectedValue: string): ToolCallOutput {
	const choice = json.choices[0];
	assert(
		choice?.finish_reason === "tool_calls",
		`Expected tool_calls, got ${choice?.finish_reason}`,
	);
	const call = choice.message.tool_calls?.[0];
	assert(call, "Expected one tool call");
	assert(call.function.name === TOOL.function.name, `Unexpected tool ${call.function.name}`);
	const args = JSON.parse(call.function.arguments) as { value?: string };
	assert(args.value === expectedValue, `Expected ${expectedValue}, got ${call.function.arguments}`);
	return call;
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
					instruction: "Return this value exactly in the final answer and request no further action.",
				}),
			},
		],
		tools: [TOOL],
		tool_choice: "auto",
	};
}

function expectFinal(json: ChatCompletionResponse, marker: string): void {
	const choice = json.choices[0];
	assert(choice?.finish_reason === "stop", `Expected stop, got ${choice?.finish_reason}`);
	assert(
		choice.message.content?.includes(marker),
		`Expected final marker ${marker}, got ${choice.message.content ?? "<null>"}`,
	);
}

console.log(`DeepSeek isolation E2E: ${baseUrl} model=${model}`);
console.log(`sessions: A=${sessionA} B=${sessionB}`);

const initialA = initialBody("deepseek-A");
const a = await post(sessionA, initialA);
expectStateful(a.response, "initial", "full");
const callA = firstToolCall(a.json, "deepseek-A");
console.log("A bootstrap: stateful full prompt");

const initialB = initialBody("deepseek-B");
const b = await post(sessionB, initialB);
expectStateful(b.response, "initial", "full");
const callB = firstToolCall(b.json, "deepseek-B");
assert(callA.id !== callB.id, "Sessions A and B unexpectedly received the same gateway tool_call.id");
console.log("B bootstrap: independent stateful full prompt");

const finalA = await post(sessionA, continuationBody(initialA, callA, "deepseek-A-ok"));
expectStateful(finalA.response, "append", "delta");
expectFinal(finalA.json, "deepseek-A-ok");
assert(
	!finalA.json.choices[0]?.message.content?.includes("deepseek-B-ok"),
	"Session A leaked session B final marker",
);
console.log("A continuation: append/delta preserved A state");

const finalB = await post(sessionB, continuationBody(initialB, callB, "deepseek-B-ok"));
expectStateful(finalB.response, "append", "delta");
expectFinal(finalB.json, "deepseek-B-ok");
assert(
	!finalB.json.choices[0]?.message.content?.includes("deepseek-A-ok"),
	"Session B leaked session A final marker",
);
console.log("B continuation: append/delta preserved B state");

const resetBody = initialBody("deepseek-A-reset", true);
const resetA = await post(sessionA, resetBody);
expectStateful(resetA.response, "diverged", "rehydrate");
firstToolCall(resetA.json, "deepseek-A-reset");
assert(
	header(resetA.response, "x-webtoapi-history-epoch") === "2",
	`Expected A epoch 2, got ${header(resetA.response, "x-webtoapi-history-epoch")}`,
);
console.log("A reset: divergence rehydrated A into epoch 2");

const postResetB: ChatCompletionRequest = {
	model,
	messages: [...initialB.messages, { role: "user", content: "Reply only with deepseek-B-still-isolated." }],
	tools: [TOOL],
	tool_choice: "auto",
};
const bAfterReset = await post(sessionB, postResetB);
expectStateful(bAfterReset.response, "append", "delta");
assert(
	header(bAfterReset.response, "x-webtoapi-history-epoch") === "1",
	`Session B epoch changed unexpectedly: ${header(bAfterReset.response, "x-webtoapi-history-epoch")}`,
);
assert(
	bAfterReset.json.choices[0]?.message.content?.includes("deepseek-B-still-isolated"),
	`Session B did not survive A reset independently: ${bAfterReset.json.choices[0]?.message.content ?? "<null>"}`,
);
console.log("B after A reset: remained epoch 1 and independently stateful");

console.log(
	`PASS: DeepSeek A/B isolation, append-only delta continuity, and per-session epoch reset verified for ${runId}`,
);
