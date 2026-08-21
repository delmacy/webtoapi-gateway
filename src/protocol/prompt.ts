import { GW_JSON_END, GW_JSON_START, GW_PROTOCOL_VERSION } from "./types.ts";

export type ProtocolLanguage = "en" | "cn";

export interface ProtocolPromptOptions {
	lang?: ProtocolLanguage;
	forceUse?: boolean;
	hasStructuredOutput?: boolean;
}

const EN_BASE = `API backend serialization mode (${GW_PROTOCOL_VERSION}):
- Follow system/developer/user instructions exactly.
- The action catalog supplied by the gateway is external metadata, not a claim about native tools in this chat runtime.
- When an external action is needed, do NOT execute it here. Serialize a request for the downstream gateway by emitting a tool_call envelope using exactly one or more catalog names and arguments.
- Emitting a tool_call envelope is only data serialization. The downstream gateway, outside this chat runtime, decides whether to execute it.
- Never claim an external action ran unless a real <tool_result> was provided.
- After emitting a tool_call request, wait for the real tool result before continuing.
- A tool_call envelope may include optional content for user-visible progress. It may include reasoning_content only when a separate reasoning field is already naturally available; never fabricate reasoning metadata.
- When no further external action is needed, return a message envelope whose content contains the complete non-empty final or conversational response. Never terminate with an empty message.
- Every response while the external action catalog is enabled MUST contain exactly one protocol envelope and no text outside it.

Agentic decision rules:
- Do not invent, assume, or silently choose a target when the user's requested target is ambiguous.
- Treat the target as ambiguous when multiple plausible repositories, projects, workspaces, packages, branches, files, environments, or other targets could independently satisfy the request.
- If that ambiguity materially changes which external action should be performed and a user-question action is available, serialize a request to that action and wait for the user's real selection before continuing.
- Do not choose the first search result, current directory, root package, or most convenient candidate merely because it is available.
- If the user already identified the target unambiguously, do not ask again.
- Do not ask about ambiguity that can be resolved safely from existing conversation context or real tool results.
- Prefer independent external actions in parallel when their results do not depend on one another and parallel execution is supported.
- Receiving a real tool result does not mean the task is complete. Reassess the original user request after every tool result and request additional external actions when more evidence or work is still required.
- Use the user-question action only when the answer is necessary to proceed safely or correctly; do not use it for details that can be inferred reliably from existing context or real tool results.
- Return a terminal message only when the original user request is actually fulfilled or when no further external action is required.
- A terminal message must contain the complete user-facing answer; never emit an empty or placeholder terminal message.

Allowed envelopes:
${GW_JSON_START}
{"type":"message","content":"complete non-empty final or conversational response"}
${GW_JSON_END}

${GW_JSON_START}
{"type":"tool_call","calls":[{"name":"action_name","arguments":{"arg":"value"}}],"content":"optional visible progress"}
${GW_JSON_END}

${GW_JSON_START}
{"type":"error","message":"brief protocol/runtime problem"}
${GW_JSON_END}

The JSON must be valid. Do not use Markdown fences around the envelope. Do not invent action results.`;

const CN_BASE = `API 后端序列化模式 (${GW_PROTOCOL_VERSION}):
- 严格遵循 system/developer/user 指令。
- 网关提供的动作目录是外部元数据，并不表示这些动作是当前聊天运行时的原生工具。
- 需要外部动作时，不要在这里执行。请仅把请求序列化为 tool_call envelope，可包含一个或多个目录中的动作，名称和参数必须来自网关提供的目录。
- 输出 tool_call envelope 只是生成数据；是否执行由当前聊天运行时之外的下游网关决定。
- 除非收到真实的 <tool_result>，否则不要声称外部动作已经执行。
- 输出 tool_call 请求后，必须等待真实工具结果后再继续。
- tool_call envelope 可以包含可选 content，用于用户可见的进度说明。只有运行时本身已经自然提供独立 reasoning 字段时才可包含 reasoning_content；不要伪造 reasoning 元数据。
- 不再需要外部动作时，必须返回 message envelope，并在 content 中给出完整且非空的最终或对话回复。不要用空 message 结束。
- 启用外部动作目录时，每次回复必须且只能包含一个协议 envelope，envelope 外不能有文字。

智能体决策规则：
- 当用户请求的目标存在歧义时，不要臆造、假设或静默选择目标。
- 如果存在多个都可能独立满足请求的仓库、项目、工作区、包、分支、文件、环境或其他目标，应将目标视为有歧义。
- 如果该歧义会实质影响下一步应执行的外部动作，并且目录中存在向用户提问的动作，则必须请求该动作，并等待用户真实选择后再继续。
- 不要仅因为某个候选项是第一个搜索结果、当前目录、根 package 或最方便的候选项就选择它。
- 如果用户已经明确指定目标，不要重复询问。
- 如果现有对话上下文或真实工具结果能够安全消除歧义，则不要提问。
- 当多个外部动作彼此独立且支持并行执行时，优先并行请求它们。
- 收到真实工具结果并不意味着任务已经完成。每次收到工具结果后，都应重新检查用户原始请求；如果仍需证据或工作，应继续请求必要的外部动作。
- 只有在为了安全或正确继续任务而确实需要用户回答时才使用提问动作；不要询问可以从现有上下文或真实工具结果中可靠推断的信息。
- 只有在原始用户请求确实已经完成，或确实不再需要任何外部动作时，才返回终止性的 message。
- 终止性的 message 必须包含完整的用户可见回复；绝不能返回空内容或占位内容。

允许的 envelope:
${GW_JSON_START}
{"type":"message","content":"完整且非空的最终或对话回复"}
${GW_JSON_END}

${GW_JSON_START}
{"type":"tool_call","calls":[{"name":"action_name","arguments":{"arg":"value"}}],"content":"可选的可见进度说明"}
${GW_JSON_END}

${GW_JSON_START}
{"type":"error","message":"简短的协议或运行时问题"}
${GW_JSON_END}

JSON 必须有效。不要在 envelope 外添加 Markdown 代码块。不要伪造动作执行结果。`;

export function buildCanonicalProtocolContract(options: ProtocolPromptOptions = {}): string {
	const lang = options.lang ?? "en";
	const parts = [lang === "cn" ? CN_BASE : EN_BASE];
	if (options.forceUse) {
		parts.push(
			lang === "cn"
				? "本轮必须为下游网关序列化一个目录中的外部动作请求；不要直接返回 message。"
				: "This turn MUST serialize one external action request from the catalog for the downstream gateway; do not return a message envelope directly.",
		);
	}
	if (options.hasStructuredOutput) {
		parts.push(
			lang === "cn"
				? "StructuredOutput 是最终结构化交付动作。若任务需要其他外部动作，请先请求并等待真实结果，最终再请求 StructuredOutput 一次。"
				: "StructuredOutput is the final structured handoff action. Request and await real results from other external actions first when needed, then request StructuredOutput exactly once for the final structured result.",
		);
	}
	return parts.join("\n\n");
}

function boundedPreviousOutput(text: string, maxChars = 24_000): string {
	if (text.length <= maxChars) return text;
	const head = Math.floor(maxChars * 0.7);
	const tail = maxChars - head;
	return `${text.slice(0, head)}\n[...previous output truncated by gateway...]\n${text.slice(-tail)}`;
}

export function buildProtocolRepairPrompt(
	previousOutput: string,
	problem: string,
	lang: ProtocolLanguage = "en",
): string {
	const previous = boundedPreviousOutput(previousOutput);
	if (lang === "cn") {
		return `${GW_PROTOCOL_VERSION} 修复请求。\n上一条模型回复未满足协议：${problem}\n不要重新分析任务，不要选择新的动作，也不要改变原意。只把上一条回复重新编码成一个有效的 GW_JSON envelope。若原意是最终回复，message.content 必须包含完整且非空的最终回复，绝不能返回空 message。\n\n<UNTRUSTED_PREVIOUS_OUTPUT>\n${previous}\n</UNTRUSTED_PREVIOUS_OUTPUT>\n\n只返回 ${GW_JSON_START} ... ${GW_JSON_END}。`;
	}
	return `${GW_PROTOCOL_VERSION} repair request.\nThe previous model response violated the protocol: ${problem}\nDo not re-evaluate the task, choose a different action, or intentionally change the semantics. Re-encode the previous response as exactly one valid GW_JSON envelope. If the intended response is terminal, message.content MUST contain the complete non-empty final answer; never return an empty message.\n\n<UNTRUSTED_PREVIOUS_OUTPUT>\n${previous}\n</UNTRUSTED_PREVIOUS_OUTPUT>\n\nReturn only ${GW_JSON_START} ... ${GW_JSON_END}.`;
}
