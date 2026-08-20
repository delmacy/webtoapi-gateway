import type { CanonicalEvent } from "./canonical.ts";

export type HistoryRelation = "initial" | "exact" | "append" | "rewind" | "diverged";
export type ProviderHistoryAction = "bootstrap" | "noop" | "append" | "rehydrate";

export interface HistoryReconciliation {
	relation: HistoryRelation;
	action: ProviderHistoryAction;
	commonPrefixEvents: number;
	previousEvents: number;
	incomingEvents: number;
	deltaEvents: CanonicalEvent[];
	removedEvents: number;
	divergenceAt?: number;
	requiresRehydrate: boolean;
}

export function longestCommonEventPrefix(
	previous: CanonicalEvent[],
	incoming: CanonicalEvent[],
): number {
	const limit = Math.min(previous.length, incoming.length);
	let index = 0;
	while (index < limit && previous[index]?.hash === incoming[index]?.hash) index += 1;
	return index;
}

export function reconcileCanonicalHistory(
	previous: CanonicalEvent[],
	incoming: CanonicalEvent[],
): HistoryReconciliation {
	const commonPrefixEvents = longestCommonEventPrefix(previous, incoming);
	const base = {
		commonPrefixEvents,
		previousEvents: previous.length,
		incomingEvents: incoming.length,
		removedEvents: Math.max(0, previous.length - commonPrefixEvents),
	};

	if (previous.length === 0) {
		return {
			...base,
			relation: "initial",
			action: "bootstrap",
			deltaEvents: incoming,
			requiresRehydrate: false,
		};
	}

	if (commonPrefixEvents === previous.length && commonPrefixEvents === incoming.length) {
		return {
			...base,
			relation: "exact",
			action: "noop",
			deltaEvents: [],
			requiresRehydrate: false,
		};
	}

	if (commonPrefixEvents === previous.length && incoming.length > previous.length) {
		return {
			...base,
			relation: "append",
			action: "append",
			deltaEvents: incoming.slice(commonPrefixEvents),
			requiresRehydrate: false,
		};
	}

	if (commonPrefixEvents === incoming.length && previous.length > incoming.length) {
		return {
			...base,
			relation: "rewind",
			action: "rehydrate",
			deltaEvents: incoming,
			divergenceAt: commonPrefixEvents,
			requiresRehydrate: true,
		};
	}

	return {
		...base,
		relation: "diverged",
		action: "rehydrate",
		deltaEvents: incoming,
		divergenceAt: commonPrefixEvents,
		requiresRehydrate: true,
	};
}
