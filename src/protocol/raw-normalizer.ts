import type { ToolDefinition } from "../openai/types.ts";
import { type CanonicalToolResponse, parseCanonicalToolResponse } from "./parser.ts";
import { GatewayProtocolError, GW_JSON_END, GW_JSON_START } from "./types.ts";

export type RawNormalizationMode =
	| "exact-envelope"
	| "envelope-with-prose"
	| "bare-json"
	| "fenced-json"
	| "embedded-json"
	| "xml-tool-calls";

export interface NormalizedProtocolResponse {
	parsed: CanonicalToolResponse;
	mode: RawNormalizationMode;
	canonicalText: string;
}

type JsonSchema = Record<string, unknown>;

const DEBUG_PREVIEW_CHARS = 800;
const XML_NAME = "[A-Za-z_][A-Za-z0-9_.-]*";

function wrapJson(raw: string): string {
	return `${GW_JSON_START}\n${raw.trim()}\n${GW_JSON_END}`;
}

function extractSingleEnvelope(text: string): string | undefined {
	const start = text.indexOf(GW_JSON_START);
	const end = text.indexOf(GW_JSON_END, start + GW_JSON_START.length);
	if (start < 0 || end < 0) return undefined;
	if (text.indexOf(GW_JSON_START, start + GW_JSON_START.length) >= 0) return undefined;
	if (text.indexOf(GW_JSON_END, end + GW_JSON_END.length) >= 0) return undefined;
	return text.slice(start, end + GW_JSON_END.length);
}

function extractFencedJson(text: string): string[] {
	const matches: string[] = [];
	const re = /```(?:json)?\s*([\s\S]*?)```/gi;
	for (const match of text.matchAll(re)) {
		const body = match[1]?.trim();
		if (body) matches.push(body);
	}
	return matches;
}

function extractBalancedObjects(text: string): string[] {
	const results: string[] = [];
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") {
			if (depth === 0) start = i;
			depth += 1;
			continue;
		}
		if (ch === "}" && depth > 0) {
			depth -= 1;
			if (depth === 0 && start >= 0) {
				results.push(text.slice(start, i + 1));
				start = -1;
			}
		}
	}
	return results;
}

function parsesAsJsonObject(raw: string): boolean {
	try {
		const value = JSON.parse(raw);
		return typeof value === "object" && value !== null && !Array.isArray(value);
	} catch {
		return false;
	}
}

function parseCandidate(
	rawJson: string,
	requestedTools: ToolDefinition[] | undefined,
	mode: RawNormalizationMode,
): NormalizedProtocolResponse {
	const canonicalText = wrapJson(rawJson);
	return {
		parsed: parseCanonicalToolResponse(canonicalText, requestedTools),
		mode,
		canonicalText,
	};
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function schemaProperties(tool: ToolDefinition): Record<string, JsonSchema> {
	const parameters = (tool.function.parameters ?? {}) as JsonSchema;
	if (!parameters.properties || typeof parameters.properties !== "object") return {};
	return parameters.properties as Record<string, JsonSchema>;
}

function xmlScalarValue(raw: string, schema: JsonSchema): unknown {
	const text = raw.trim();
	if (schema.type === "integer") {
		return /^-?\d+$/.test(text) ? Number(text) : text;
	}
	if (schema.type === "number") {
		const value = Number(text);
		return text !== "" && Number.isFinite(value) ? value : text;
	}
	if (schema.type === "boolean") {
		if (text === "true") return true;
		if (text === "false") return false;
		return text;
	}
	if (schema.type === "array" || schema.type === "object") {
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}
	return text;
}

function parseXmlArguments(body: string, tool: ToolDefinition): Record<string, unknown> {
	const properties = schemaProperties(tool);
	const argumentsObject: Record<string, unknown> = {};
	const childRegex = new RegExp(`<(${XML_NAME})>\\s*([\\s\\S]*?)\\s*</\\1>`, "g");
	let cursor = 0;
	let matched = false;

	for (const match of body.matchAll(childRegex)) {
		matched = true;
		const index = match.index ?? 0;
		if (body.slice(cursor, index).trim() !== "") {
			throw new GatewayProtocolError(
				"invalid_envelope",
				`XML-like tool call for "${tool.function.name}" contained malformed or nested argument content.`,
			);
		}
		const name = match[1]!;
		const rawValue = match[2] ?? "";
		const schema = properties[name];
		if (!schema) {
			throw new GatewayProtocolError(
				"invalid_arguments",
				`XML-like tool call for "${tool.function.name}" contained unknown argument "${name}".`,
			);
		}
		if (Object.hasOwn(argumentsObject, name)) {
			throw new GatewayProtocolError(
				"invalid_arguments",
				`XML-like tool call for "${tool.function.name}" repeated argument "${name}".`,
			);
		}
		argumentsObject[name] = xmlScalarValue(rawValue, schema);
		cursor = index + match[0].length;
	}

	if (!matched || body.slice(cursor).trim() !== "") {
		throw new GatewayProtocolError(
			"invalid_envelope",
			`XML-like tool call for "${tool.function.name}" was not a flat argument structure.`,
		);
	}
	return argumentsObject;
}

function normalizeXmlToolCalls(
	text: string,
	requestedTools: ToolDefinition[] | undefined,
): NormalizedProtocolResponse | undefined {
	if (!requestedTools || requestedTools.length === 0) return undefined;
	const toolMap = new Map(requestedTools.map((tool) => [tool.function.name, tool]));
	const alternation = requestedTools.map((tool) => escapeRegex(tool.function.name)).join("|");
	if (!alternation) return undefined;

	const blockRegex = new RegExp(`<(${alternation})>\\s*([\\s\\S]*?)\\s*</\\1>`, "g");
	const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
	let cursor = 0;
	let outside = "";

	for (const match of text.matchAll(blockRegex)) {
		const index = match.index ?? 0;
		outside += text.slice(cursor, index);
		const name = match[1]!;
		const tool = toolMap.get(name);
		if (!tool) return undefined;
		calls.push({ name, arguments: parseXmlArguments(match[2] ?? "", tool) });
		cursor = index + match[0].length;
	}

	if (calls.length === 0) return undefined;
	outside += text.slice(cursor);

	const leftoverTag = outside.match(new RegExp(`<\\/?(${XML_NAME})(?:\\s[^>]*)?>`));
	if (leftoverTag) {
		const unknownName = leftoverTag[1] ?? "unknown";
		if (!toolMap.has(unknownName)) {
			throw new GatewayProtocolError(
				"unknown_tool",
				`XML-like output referenced unknown tool "${unknownName}".`,
			);
		}
		throw new GatewayProtocolError(
			"invalid_envelope",
			"XML-like tool output contained an unmatched or malformed tool block.",
		);
	}

	return parseCandidate(JSON.stringify({ type: "tool_call", calls }), requestedTools, "xml-tool-calls");
}

function debugEnabled(): boolean {
	return process.env.WEBTOAPI_PROTOCOL_DEBUG === "1";
}

function logProtocolFailure(error: GatewayProtocolError, raw: string): void {
	if (!debugEnabled()) return;
	const start = raw.slice(0, DEBUG_PREVIEW_CHARS);
	const end = raw.slice(-DEBUG_PREVIEW_CHARS);
	console.warn(
		`[protocol-debug] code=${error.code} chars=${raw.length} start=${JSON.stringify(start)} end=${JSON.stringify(end)}`,
	);
}

function normalizeRawProtocolResponseInternal(
	sanitized: string,
	requestedTools?: ToolDefinition[],
): NormalizedProtocolResponse {
	try {
		return {
			parsed: parseCanonicalToolResponse(sanitized, requestedTools),
			mode: "exact-envelope",
			canonicalText: sanitized,
		};
	} catch (strictError) {
		if (!(strictError instanceof GatewayProtocolError)) throw strictError;

		if (strictError.code === "trailing_content") {
			const envelope = extractSingleEnvelope(sanitized);
			if (envelope) {
				return {
					parsed: parseCanonicalToolResponse(envelope, requestedTools),
					mode: "envelope-with-prose",
					canonicalText: envelope,
				};
			}
		}

		if (parsesAsJsonObject(sanitized)) {
			return parseCandidate(sanitized, requestedTools, "bare-json");
		}

		const fenced = extractFencedJson(sanitized).filter(parsesAsJsonObject);
		if (fenced.length === 1) {
			return parseCandidate(fenced[0]!, requestedTools, "fenced-json");
		}
		if (fenced.length > 1) {
			throw new GatewayProtocolError(
				"multiple_envelopes",
				"Raw response contained multiple JSON code blocks; refusing to guess which one is authoritative.",
			);
		}

		const embedded = extractBalancedObjects(sanitized).filter(parsesAsJsonObject);
		if (embedded.length === 1) {
			return parseCandidate(embedded[0]!, requestedTools, "embedded-json");
		}
		if (embedded.length > 1) {
			throw new GatewayProtocolError(
				"multiple_envelopes",
				"Raw response contained multiple JSON objects; refusing to guess which one is authoritative.",
			);
		}

		const xml = normalizeXmlToolCalls(sanitized, requestedTools);
		if (xml) return xml;

		throw strictError;
	}
}

/**
 * Deterministically normalizes raw model output without inferring semantic intent.
 * Only already-structured protocol JSON or exact XML-like tool blocks are recovered.
 * Natural-language tool intent is never converted into an action.
 *
 * Set WEBTOAPI_PROTOCOL_DEBUG=1 to log bounded raw previews for final protocol
 * failures. Debug logging is opt-in because raw provider output can contain
 * repository or user content.
 */
export function normalizeRawProtocolResponse(
	text: string,
	requestedTools?: ToolDefinition[],
): NormalizedProtocolResponse {
	const sanitized = text.replace(/^\uFEFF/, "").trim();
	try {
		return normalizeRawProtocolResponseInternal(sanitized, requestedTools);
	} catch (error) {
		if (error instanceof GatewayProtocolError) logProtocolFailure(error, sanitized);
		throw error;
	}
}
