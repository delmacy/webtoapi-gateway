import type { ChatCompletionRequest, ChatMessage } from "../openai/types.ts";
import { GW_JSON_END, GW_JSON_START, GW_PROTOCOL_VERSION } from "../protocol/types.ts";
import { buildPromptFromMessages, resolveEffectiveTools } from "../tool-calling/converter.ts";
import type { CanonicalEventKind } from "./canonical.ts";
import type { SessionReconciliation } from "./store.ts";

export type ProviderPromptMode = "full" | "delta" | "rehydrate" | "retry-rehydrate";

export interface ProviderPromptPlan {
	prompt: string;
	fullPrompt: string;
	hasTools: boolean;
	mode: ProviderPromptMode;
	statefulSession: boolean;
	resetSession: boolean;
	deltaMessages: number;
	rehydrationOmittedMessages: number;
}

const DEFAULT_REHYDRATION_MAX_CHARS = 180_000;
const MIN_REHYDRATION_MAX_CHARS = 8_192;

const FORWARD_DELTA_KINDS = new Set<CanonicalEventKind>([
	"system_instruction",
	"developer_instruction",
	"user_message",
	"tool_result",
]);

function uniqueForwardMessageIndexes(reconciliation: SessionReconciliation): number[] {
	const indexes = new Set<number>();
	for (const event of reconciliation.deltaEvents) {
		if (FORWARD_DELTA_KINDS.has(event.kind)) indexes.add(event.sourceMessageIndex);
	}
	return [...indexes].sort((a, b) => a - b);
}

function selectDeltaMessages(
	messages: ChatMessage[],
	reconciliation: SessionReconciliation,
): ChatMessage[] {
	return uniqueForwardMessageIndexes(reconciliation)
		.map((index) => messages[index])
		.filter((message): message is ChatMessage => message !== undefined);
}

function continuationReminder(
	body: ChatCompletionRequest,
	reconciliation: SessionReconciliation,
): string {
	const registry = reconciliation.toolRegistry?.hash
		? ` Tool registry unchanged: ${reconciliation.toolRegistry.hash.slice(0, 16)}.`
		: "";
	const force = body.tool_choice === "required" ? " This turn still requires a tool call." : "";
	return `${GW_PROTOCOL_VERSION} continuation.${registry} Preserve all prior instructions.${force} While tools are enabled, return exactly one ${GW_JSON_START} ... ${GW_JSON_END} envelope and no text outside it.`;
}

function configuredRehydrationMaxChars(explicit?: number): number {
	if (explicit !== undefined && Number.isFinite(explicit)) {
		return Math.max(MIN_REHYDRATION_MAX_CHARS, Math.floor(explicit));
	}
	const configured = Number(process.env.WEBTOAPI_REHYDRATION_MAX_CHARS);
	if (Number.isFinite(configured) && configured > 0) {
		return Math.max(MIN_REHYDRATION_MAX_CHARS, Math.floor(configured));
	}
	return DEFAULT_REHYDRATION_MAX_CHARS;
}

function isInstructionMessage(message: ChatMessage): boolean {
	return message.role === "system" || message.role === "developer";
}

function buildBoundedRehydrationPrompt(
	body: ChatCompletionRequest,
	compactTools: boolean,
	fullPrompt: string,
	maxChars: number,
): { prompt: string; omittedMessages: number } {
	if (fullPrompt.length <= maxChars || body.messages.length <= 1) {
		return { prompt: fullPrompt, omittedMessages: 0 };
	}

	const instructionIndexes = new Set<number>();
	for (let index = 0; index < body.messages.length; index += 1) {
		const message = body.messages[index];
		if (message && isInstructionMessage(message)) instructionIndexes.add(index);
	}

	const render = (suffixStart: number) => {
		const selected = body.messages.filter(
			(_message, index) => instructionIndexes.has(index) || index >= suffixStart,
		);
		return buildPromptFromMessages(selected, body.tools, body.tool_choice, compactTools).prompt;
	};

	let bestStart = body.messages.length - 1;
	let bestPrompt = render(bestStart);
	if (bestPrompt.length > maxChars) {
		// Instructions + the latest semantic turn cannot be reduced safely. Preserve the full
		// request instead of truncating instructions or splitting a message mid-content.
		return { prompt: fullPrompt, omittedMessages: 0 };
	}

	for (let start = bestStart - 1; start >= 0; start -= 1) {
		const candidate = render(start);
		if (candidate.length > maxChars) break;
		bestStart = start;
		bestPrompt = candidate;
	}

	const retainedIndexes = new Set<number>();
	for (const index of instructionIndexes) retainedIndexes.add(index);
	for (let index = bestStart; index < body.messages.length; index += 1) retainedIndexes.add(index);
	const omittedMessages = body.messages.length - retainedIndexes.size;
	if (omittedMessages > 0) {
		console.warn(
			`[session] bounded rehydration prompt chars=${bestPrompt.length}/${maxChars} omittedMessages=${omittedMessages}`,
		);
	}
	return { prompt: bestPrompt, omittedMessages };
}

export function buildProviderPromptPlan(
	body: ChatCompletionRequest,
	reconciliation: SessionReconciliation,
	options: { compactTools: boolean; statefulEligible: boolean; rehydrationMaxChars?: number },
): ProviderPromptPlan {
	const effective = resolveEffectiveTools(body.tools, body.tool_choice);
	const hasTools = effective.tools.length > 0;
	const full = buildPromptFromMessages(
		body.messages,
		body.tools,
		body.tool_choice,
		options.compactTools,
	);
	const boundedRehydration = buildBoundedRehydrationPrompt(
		body,
		options.compactTools,
		full.prompt,
		configuredRehydrationMaxChars(options.rehydrationMaxChars),
	);

	if (!options.statefulEligible || !hasTools) {
		return {
			prompt: full.prompt,
			fullPrompt: boundedRehydration.prompt,
			hasTools,
			mode: reconciliation.requiresRehydrate ? "rehydrate" : "full",
			statefulSession: false,
			resetSession: false,
			deltaMessages: body.messages.length,
			rehydrationOmittedMessages: boundedRehydration.omittedMessages,
		};
	}

	if (reconciliation.relation === "initial") {
		return {
			prompt: full.prompt,
			fullPrompt: boundedRehydration.prompt,
			hasTools,
			mode: "full",
			statefulSession: true,
			resetSession: true,
			deltaMessages: body.messages.length,
			rehydrationOmittedMessages: boundedRehydration.omittedMessages,
		};
	}

	if (reconciliation.requiresRehydrate) {
		return {
			prompt: boundedRehydration.prompt,
			fullPrompt: boundedRehydration.prompt,
			hasTools,
			mode: "rehydrate",
			statefulSession: true,
			resetSession: true,
			deltaMessages: body.messages.length - boundedRehydration.omittedMessages,
			rehydrationOmittedMessages: boundedRehydration.omittedMessages,
		};
	}

	if (reconciliation.relation === "exact") {
		return {
			prompt: boundedRehydration.prompt,
			fullPrompt: boundedRehydration.prompt,
			hasTools,
			mode: "retry-rehydrate",
			statefulSession: true,
			resetSession: true,
			deltaMessages: body.messages.length - boundedRehydration.omittedMessages,
			rehydrationOmittedMessages: boundedRehydration.omittedMessages,
		};
	}

	const deltaMessages = selectDeltaMessages(body.messages, reconciliation);
	if (deltaMessages.length === 0) {
		return {
			prompt: boundedRehydration.prompt,
			fullPrompt: boundedRehydration.prompt,
			hasTools,
			mode: "rehydrate",
			statefulSession: true,
			resetSession: true,
			deltaMessages: body.messages.length - boundedRehydration.omittedMessages,
			rehydrationOmittedMessages: boundedRehydration.omittedMessages,
		};
	}

	const resendTools = reconciliation.toolRegistryChanged;
	const delta = buildPromptFromMessages(
		deltaMessages,
		resendTools ? body.tools : undefined,
		resendTools ? body.tool_choice : undefined,
		options.compactTools,
	);
	const reminder = resendTools ? "" : continuationReminder(body, reconciliation);
	const prompt = [reminder, delta.prompt].filter(Boolean).join("\n\n");

	return {
		prompt,
		fullPrompt: boundedRehydration.prompt,
		hasTools,
		mode: "delta",
		statefulSession: true,
		resetSession: false,
		deltaMessages: deltaMessages.length,
		rehydrationOmittedMessages: boundedRehydration.omittedMessages,
	};
}
