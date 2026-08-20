/**
 * Dynamic tool prompt generation from OpenAI function definitions.
 *
 * Optimized mode renders compact signatures and uses GW_AGENT_PROTOCOL/1.
 * Passthrough mode preserves the legacy tool_json prompt for compatibility.
 */

import type { ToolDefinition } from "../openai/types.ts";
import { buildCanonicalProtocolContract } from "../protocol/prompt.ts";

type JsonSchema = Record<string, unknown>;

function bounded(text: string, max = 180): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function renderSchemaType(schema: JsonSchema, depth = 0): string {
	if (depth > 2) return String(schema.type ?? "any");
	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		return schema.enum.map((value) => JSON.stringify(value)).join("|");
	}

	const type = typeof schema.type === "string" ? schema.type : "any";
	if (type === "array") {
		const items =
			schema.items && typeof schema.items === "object" ? (schema.items as JsonSchema) : {};
		return `array<${renderSchemaType(items, depth + 1)}>`;
	}
	if (type === "object") {
		const properties =
			schema.properties && typeof schema.properties === "object"
				? (schema.properties as Record<string, JsonSchema>)
				: {};
		const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
		const fields = Object.entries(properties).map(
			([name, child]) =>
				`${name}${required.has(name) ? "!" : "?"}:${renderSchemaType(child, depth + 1)}`,
		);
		return fields.length > 0 ? `{${fields.join(",")}}` : "object";
	}
	return type;
}

function renderToolSignature(tool: ToolDefinition): string {
	const schema = (tool.function.parameters ?? {}) as JsonSchema;
	const properties =
		schema.properties && typeof schema.properties === "object"
			? (schema.properties as Record<string, JsonSchema>)
			: {};
	const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
	const args = Object.entries(properties).map(
		([name, child]) => `${name}${required.has(name) ? "!" : "?"}:${renderSchemaType(child)}`,
	);
	const description = tool.function.description ? ` — ${bounded(tool.function.description)}` : "";
	return `"${tool.function.name}"(${args.join(", ")})${description}`;
}

export function toolDefsForPrompt(tools: ToolDefinition[], compact = true): string {
	if (!compact) {
		return JSON.stringify(
			tools.map((t) => ({
				name: t.function.name,
				description: t.function.description || "",
				parameters: t.function.parameters || {},
			})),
			null,
			2,
		);
	}
	return tools.map(renderToolSignature).join("\n");
}

const STRUCTURED_OUTPUT_CONTRACT = `Structured output is enabled via the StructuredOutput tool.
Use normal tools first if the task requires work. When the final answer is ready, call StructuredOutput exactly once with data matching its schema. Do not print the structured result as plain text and do not invent validation success.`;

const TOOL_EXAMPLE = `Example: to add 1 to number 5, return ONLY:
\`\`\`tool_json
{"tool":"plus_one","parameters":{"number":"5"}}
\`\`\`
(plus_one is just an example, not a real tool)`;

const TOOL_EXAMPLE_CN = `示例: 要给数字5加1，只返回:
\`\`\`tool_json
{"tool":"plus_one","parameters":{"number":"5"}}
\`\`\`
(plus_one仅为示例，非真实工具)`;

export function buildToolPrompt(
	tools: ToolDefinition[],
	lang: "en" | "cn" = "en",
	forceUse = false,
	compact = true,
): string {
	const defs = toolDefsForPrompt(tools, compact);
	const hasStructuredOutput = tools.some((tool) => tool.function.name === "StructuredOutput");

	if (compact) {
		const contract = buildCanonicalProtocolContract({ lang, forceUse, hasStructuredOutput });
		const signatureHint =
			lang === "cn"
				? "工具签名中 ! 表示必填参数，? 表示可选参数。"
				: "In tool signatures, ! means required and ? means optional.";
		const toolsLabel = lang === "cn" ? "可用工具:" : "Available tools:";
		return `${contract}\n\n${signatureHint}\n\n${toolsLabel}\n${defs}\n`;
	}

	const structuredContract = hasStructuredOutput ? `\n\n${STRUCTURED_OUTPUT_CONTRACT}` : "";
	if (lang === "cn") {
		const forceHint = forceUse
			? "\n\n重要：你必须使用上述工具之一来回应。请不要直接用文字回答，必须调用工具。"
			: "";
		return `你可以使用以下工具。当需要使用工具时，只返回tool_json代码块，不要包含其他文字。

可用工具:
${defs}

${TOOL_EXAMPLE_CN}

需要使用工具时，只返回一个tool_json块。不需要工具则直接回答。${structuredContract}${forceHint}

`;
	}

	const forceHint = forceUse
		? "\n\nIMPORTANT: You MUST use one of the tools above. Do NOT answer with plain text."
		: "";
	return `You have access to the following tools. When you need a tool, reply ONLY with a tool_json code block, no other text.

Available tools:
${defs}

${TOOL_EXAMPLE}

To use a tool, reply with exactly one tool_json block. If no tool is needed, answer directly.${structuredContract}${forceHint}

`;
}

export function detectLanguage(text: string): "en" | "cn" {
	const cnChars = text.match(/[\u4e00-\u9fff]/g);
	return cnChars && cnChars.length > text.length * 0.1 ? "cn" : "en";
}
