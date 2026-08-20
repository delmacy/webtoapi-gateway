import { GW_JSON_END, GW_JSON_START, GW_PROTOCOL_VERSION } from "./types.ts";

export type ProtocolLanguage = "en" | "cn";

export interface ProtocolPromptOptions {
	lang?: ProtocolLanguage;
	forceUse?: boolean;
	hasStructuredOutput?: boolean;
}

const EN_BASE = `API backend mode (${GW_PROTOCOL_VERSION}):
- Follow system/developer/user instructions exactly.
- Tools listed under Available tools are external gateway-managed functions. They do not need to exist as native tools in this chat runtime; request them by emitting a tool_call envelope and the gateway will execute them.
- Never claim a tool ran unless a real <tool_result> was provided.
- A tool call only requests execution; wait for the real tool result before continuing.
- Every response while tools are enabled MUST contain exactly one protocol envelope and no text outside it.

Allowed envelopes:
${GW_JSON_START}
{"type":"message","content":"final or conversational response"}
${GW_JSON_END}

${GW_JSON_START}
{"type":"tool_call","calls":[{"name":"tool_name","arguments":{"arg":"value"}}]}
${GW_JSON_END}

${GW_JSON_START}
{"type":"error","message":"brief protocol/runtime problem"}
${GW_JSON_END}

The JSON must be valid. Do not use Markdown fences around the envelope. Do not invent tool results.`;

const CN_BASE = `API 后端模式 (${GW_PROTOCOL_VERSION}):
- 严格遵循 system/developer/user 指令。
- “可用工具”中列出的工具由外部网关管理，不需要作为当前聊天运行时的原生工具存在；只需输出 tool_call envelope，网关会执行它们。
- 除非收到真实的 <tool_result>，否则不要声称工具已经执行。
- tool_call 只是执行请求；必须等待真实工具结果后再继续。
- 启用工具时，每次回复必须且只能包含一个协议 envelope，envelope 外不能有文字。

允许的 envelope:
${GW_JSON_START}
{"type":"message","content":"最终或对话回复"}
${GW_JSON_END}

${GW_JSON_START}
{"type":"tool_call","calls":[{"name":"tool_name","arguments":{"arg":"value"}}]}
${GW_JSON_END}

${GW_JSON_START}
{"type":"error","message":"简短的协议或运行时问题"}
${GW_JSON_END}

JSON 必须有效。不要在 envelope 外添加 Markdown 代码块。不要伪造工具执行结果。`;

export function buildCanonicalProtocolContract(options: ProtocolPromptOptions = {}): string {
	const lang = options.lang ?? "en";
	const parts = [lang === "cn" ? CN_BASE : EN_BASE];
	if (options.forceUse) {
		parts.push(
			lang === "cn"
				? "本轮必须调用一个可用工具；不要直接返回 message。"
				: "This turn MUST call one of the available tools; do not return a message envelope directly.",
		);
	}
	if (options.hasStructuredOutput) {
		parts.push(
			lang === "cn"
				? "StructuredOutput 是最终结构化交付工具。若任务需要其他工具，请先完成真实工具调用，最终再调用 StructuredOutput 一次。"
				: "StructuredOutput is the final structured handoff tool. Use real task tools first when needed, then call StructuredOutput exactly once for the final structured result.",
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
		return `${GW_PROTOCOL_VERSION} 修复请求。
上一条模型回复未满足协议：${problem}
不要重新分析任务，不要选择新的工具，不要改变原意。只把上一条回复重新编码成一个有效的 GW_JSON envelope。

<UNTRUSTED_PREVIOUS_OUTPUT>
${previous}
</UNTRUSTED_PREVIOUS_OUTPUT>

只返回 ${GW_JSON_START} ... ${GW_JSON_END}。`;
	}
	return `${GW_PROTOCOL_VERSION} repair request.
The previous model response violated the protocol: ${problem}
Do not re-evaluate the task, choose a different tool, or intentionally change the semantics. Re-encode the previous response as exactly one valid GW_JSON envelope.

<UNTRUSTED_PREVIOUS_OUTPUT>
${previous}
</UNTRUSTED_PREVIOUS_OUTPUT>

Return only ${GW_JSON_START} ... ${GW_JSON_END}.`;
}
