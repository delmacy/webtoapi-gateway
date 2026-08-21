import type { ToolDefinition } from "../openai/types.ts";
import { type CanonicalToolResponse, parseCanonicalToolResponse } from "./parser.ts";
import { GatewayProtocolError, GW_JSON_END, GW_JSON_START } from "./types.ts";

export type RawNormalizationMode =
	| "exact-envelope"
	| "envelope-with-prose"
	| "bare-json"
	| "fenced-json"
	| "embedded-json";

export interface NormalizedProtocolResponse {
	parsed: CanonicalToolResponse;
	mode: RawNormalizationMode;
	canonicalText: string;
}

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

/**
 * Deterministically normalizes raw model output without inferring semantic intent.
 * Only already-structured protocol JSON is recovered. Natural-language tool intent
 * is never converted into an action.
 */
export function normalizeRawProtocolResponse(
	text: string,
	requestedTools?: ToolDefinition[],
): NormalizedProtocolResponse {
	const sanitized = text.replace(/^\uFEFF/, "").trim();

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

		throw strictError;
	}
}
