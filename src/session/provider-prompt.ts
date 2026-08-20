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
}

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

export function buildProviderPromptPlan(
	body: ChatCompletionRequest,
	reconciliation: SessionReconciliation,
	options: { compactTools: boolean; statefulEligible: boolean },
): ProviderPromptPlan {
	const effective = resolveEffectiveTools(body.tools, body.tool_choice);
	const hasTools = effective.tools.length > 0;
	const full = buildPromptFromMessages(
		body.messages,
		body.tools,
		body.tool_choice,
		options.compactTools,
	);

	if (!options.statefulEligible || !hasTools) {
		return {
			prompt: full.prompt,
			fullPrompt: full.prompt,
			hasTools,
			mode: reconciliation.requiresRehydrate ? "rehydrate" : "full",
			statefulSession: false,
			resetSession: false,
			deltaMessages: body.messages.length,
		};
	}

	if (reconciliation.relation === "initial") {
		return {
			prompt: full.prompt,
			fullPrompt: full.prompt,
			hasTools,
			mode: "full",
			statefulSession: true,
			resetSession: true,
			deltaMessages: body.messages.length,
		};
	}

	if (reconciliation.requiresRehydrate) {
		return {
			prompt: full.prompt,
			fullPrompt: full.prompt,
			hasTools,
			mode: "rehydrate",
			statefulSession: true,
			resetSession: true,
			deltaMessages: body.messages.length,
		};
	}

	if (reconciliation.relation === "exact") {
		return {
			prompt: full.prompt,
			fullPrompt: full.prompt,
			hasTools,
			mode: "retry-rehydrate",
			statefulSession: true,
			resetSession: true,
			deltaMessages: body.messages.length,
		};
	}

	const deltaMessages = selectDeltaMessages(body.messages, reconciliation);
	if (deltaMessages.length === 0) {
		return {
			prompt: full.prompt,
			fullPrompt: full.prompt,
			hasTools,
			mode: "rehydrate",
			statefulSession: true,
			resetSession: true,
			deltaMessages: body.messages.length,
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
		fullPrompt: full.prompt,
		hasTools,
		mode: "delta",
		statefulSession: true,
		resetSession: false,
		deltaMessages: deltaMessages.length,
	};
}
