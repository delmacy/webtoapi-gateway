import type { ModelInfo } from "../types.ts";

/** Static configuration shared by all API-based providers. */
export interface ApiClientConfig {
	hostKey: string;
	startUrl: string;
	cookieDomain: string;
	defaultModel: string;
	models: ModelInfo[];
}

/** Static configuration shared by all DOM-interaction providers. */
export interface DomClientConfig {
	hostKey: string;
	startUrl: string;
	cookieDomain: string;
	models: ModelInfo[];
	/** Milliseconds between DOM polls (default 2000). */
	pollIntervalMs?: number;
	/** Maximum wait time for a response (default 120000). */
	maxWaitMs?: number;
	/** Number of consecutive stable reads before accepting (default 2). */
	stabilityThreshold?: number;
}

/** Parameters passed to `callApi` / DOM hooks after default-model resolution. */
export interface NormalizedSendParams {
	message: string;
	model: string;
	signal?: AbortSignal;
	/** Stable logical task/session id for optional upstream conversation affinity. */
	sessionId?: string;
	/** Canonical history epoch. */
	sessionEpoch?: number;
	/** Explicitly reset provider-side conversation state before sending. */
	resetSession?: boolean;
	/** Whether upstream conversation state may be reused for this request. */
	statefulSession?: boolean;
	/** Full prompt available to provider fallbacks that cannot safely consume deltas. */
	rehydrationMessage?: string;
}
