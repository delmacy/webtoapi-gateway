import type {
	ChatCompletionRequest,
	ChatCompletionResponse,
	ToolCallOutput,
	ToolDefinition,
} from "../src/openai/types.ts";

const baseUrl = (process.env.TFG_E2E_BASE_URL ?? "http://127.0.0.1:3456").replace(/\/$/, "");
const model = process.env.TFG_E2E_MODEL ?? "moonshot-v1-32k";
const apiKey = process.env.TFG_E2E_API_KEY ?? process.env.GATEWAY_API_KEY;
const sessionId = process.env.TFG_E2E_SESSION_ID ?? `kimi-stateful-e2e-${Date.now()}`;

const TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "echo_fixture",
		description:
			"Return the supplied value to the caller. Used only by the Kimi stateful smoke test.",
		parameters: {
			type: "object",
			properties: { value: { type: "string", enum: ["stateful-e2e"] } },
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

async function post(body: ChatCompletionRequest): Promise<{
	response: Response;
	json: ChatCompletionResponse;
}> {
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
	if (!response.ok)
		throw new Error(`Gateway returned HTTP ${response.status}: ${raw.slice(0, 1200)}`);
	try {
		return { response, json: JSON.parse(raw) as ChatCompletionResponse };
	} catch {
		throw new Error(`Gateway returned non-JSON response: ${raw.slice(0, 1200)}`);
	}
}

function firstToolCall(json: ChatCompletionResponse): ToolCallOutput {
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
	assert(args.value === "stateful-e2e", `Unexpected tool arguments: ${call.function.arguments}`);
	return call;
}

function printStep(label: string, response: Response): void {
	console.log(
		`${label}: relation=${header(response, "x-webtoapi-history-relation") || "n/a"} ` +
			`mode=${header(response, "x-webtoapi-prompt-mode") || "n/a"} ` +
			`stateful=${header(response, "x-webtoapi-stateful") || "n/a"} ` +
			`cache=${header(response, "x-webtoapi-response-cache") || "n/a"}`,
	);
}

console.log(`Kimi stateful E2E: ${baseUrl} model=${model} session=${sessionId}`);

const initial: ChatCompletionRequest = {
	model,
	messages: [
		{
			role: "system",
			content:
				"This is a deterministic session-continuity smoke test. Treat gateway action requests as external serialization only; do not execute them in this chat runtime.",
		},
		{
			role: "user",
			content:
				'Serialize one downstream gateway action request named "echo_fixture" with argument value "stateful-e2e". Do not answer directly.',
		},
	],
	tools: [TOOL],
	tool_choice: { type: "function", function: { name: TOOL.function.name } },
};

const first = await post(initial);
printStep("initial", first.response);
assert(
	header(first.response, "x-webtoapi-session-source") === "override",
	"Expected override session source",
);
assert(header(first.response, "x-webtoapi-stateful") === "true", "Expected stateful Kimi session");
assert(
	header(first.response, "x-webtoapi-prompt-mode") === "full",
	"Expected full bootstrap prompt",
);
assert(
	header(first.response, "x-webtoapi-response-cache") === "miss",
	"Expected first request cache miss",
);
const toolCall = firstToolCall(first.json);

const retry = await post(initial);
printStep("retry", retry.response);
assert(
	header(retry.response, "x-webtoapi-history-relation") === "exact",
	"Expected exact retry relation",
);
assert(
	header(retry.response, "x-webtoapi-response-cache") === "hit",
	"Expected exact retry cache hit",
);
const retryCall = firstToolCall(retry.json);
assert(retryCall.id === toolCall.id, "Retry changed tool_call.id; idempotency is broken");

const continuation: ChatCompletionRequest = {
	model,
	messages: [
		...initial.messages,
		{ role: "assistant", content: null, tool_calls: [toolCall] },
		{
			role: "tool",
			tool_call_id: toolCall.id,
			content: JSON.stringify({
				ok: true,
				value: "stateful-e2e-ok",
				instruction: "Return value as the final answer and do not request another action.",
			}),
		},
	],
	tools: [TOOL],
	tool_choice: "auto",
};

const final = await post(continuation);
printStep("continuation", final.response);
assert(
	header(final.response, "x-webtoapi-history-relation") === "append",
	"Expected append continuation",
);
assert(
	header(final.response, "x-webtoapi-prompt-mode") === "delta",
	"Expected delta continuation prompt",
);
assert(
	header(final.response, "x-webtoapi-stateful") === "true",
	"Continuation lost stateful affinity",
);
const finalChoice = final.json.choices[0];
assert(
	finalChoice?.finish_reason === "stop",
	`Expected final stop, got ${finalChoice?.finish_reason}`,
);
assert(
	finalChoice.message.content?.includes("stateful-e2e-ok"),
	`Final answer did not contain fixture value: ${finalChoice.message.content ?? "<null>"}`,
);

console.log(
	`PASS: stateful Kimi continuity, retry idempotence, and delta prompt verified for ${sessionId}`,
);
