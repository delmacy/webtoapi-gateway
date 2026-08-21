export const GW_PROTOCOL_VERSION = "GW_AGENT_PROTOCOL/1";
export const GW_JSON_START = "<<<GW_JSON>>>";
export const GW_JSON_END = "<<<END_GW_JSON>>>";

export interface GatewayToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

export type GatewayEnvelope =
	| {
			type: "message";
			content: string;
			/** Optional provider reasoning metadata; omit when unavailable. */
			reasoning_content?: string;
	  }
	| {
			type: "tool_call";
			calls: GatewayToolCall[];
			/** Optional user-visible progress text emitted before requesting tools. */
			content?: string;
			/** Optional provider reasoning metadata; omit when unavailable. */
			reasoning_content?: string;
	  }
	| { type: "error"; message: string };

export type GatewayProtocolErrorCode =
	| "missing_envelope"
	| "multiple_envelopes"
	| "trailing_content"
	| "invalid_json"
	| "invalid_envelope"
	| "unknown_tool"
	| "invalid_arguments"
	| "unexpected_tool_call"
	| "model_protocol_error";

export class GatewayProtocolError extends Error {
	constructor(
		public readonly code: GatewayProtocolErrorCode,
		message: string,
		public readonly details?: unknown,
	) {
		super(message);
		this.name = "GatewayProtocolError";
	}
}
