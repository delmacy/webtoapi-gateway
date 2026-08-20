import type { ChatMessage, ToolDefinition } from "../openai/types.ts";
import {
	type CanonicalEvent,
	normalizeOpenAiMessages,
	snapshotToolRegistry,
	type ToolRegistrySnapshot,
} from "./canonical.ts";
import {
	type HistoryReconciliation,
	type HistoryRelation,
	reconcileCanonicalHistory,
} from "./reconciler.ts";

export interface SessionHistorySnapshot {
	sessionId: string;
	epoch: number;
	revision: number;
	updatedAt: number;
	events: CanonicalEvent[];
	toolRegistry?: ToolRegistrySnapshot;
	lastRelation: HistoryRelation;
}

export interface SessionReconciliation extends HistoryReconciliation {
	sessionId: string;
	epoch: number;
	revision: number;
	toolRegistry?: ToolRegistrySnapshot;
	toolRegistryChanged: boolean;
}

type SessionHistoryState = SessionHistorySnapshot;

function cloneEvents(events: CanonicalEvent[]): CanonicalEvent[] {
	return events.map((event) => ({
		...event,
		payload: { ...event.payload },
	}));
}

function cloneSnapshot(state: SessionHistoryState): SessionHistorySnapshot {
	return {
		...state,
		events: cloneEvents(state.events),
		toolRegistry: state.toolRegistry
			? { ...state.toolRegistry, names: [...state.toolRegistry.names] }
			: undefined,
	};
}

export class SessionEventStore {
	private readonly sessions = new Map<string, SessionHistoryState>();

	reconcile(
		sessionId: string,
		messages: ChatMessage[],
		tools?: ToolDefinition[],
		now = Date.now(),
	): SessionReconciliation {
		const incoming = normalizeOpenAiMessages(messages);
		const registry = snapshotToolRegistry(tools);
		const existing = this.sessions.get(sessionId);
		const previous = existing?.events ?? [];
		const history = reconcileCanonicalHistory(previous, incoming);
		const toolRegistryChanged = (existing?.toolRegistry?.hash ?? "") !== (registry?.hash ?? "");
		const epoch = existing ? existing.epoch + (history.requiresRehydrate ? 1 : 0) : 1;
		const revision = (existing?.revision ?? 0) + 1;

		this.sessions.set(sessionId, {
			sessionId,
			epoch,
			revision,
			updatedAt: now,
			events: incoming,
			toolRegistry: registry,
			lastRelation: history.relation,
		});

		return {
			...history,
			sessionId,
			epoch,
			revision,
			toolRegistry: registry,
			toolRegistryChanged,
		};
	}

	get(sessionId: string): SessionHistorySnapshot | undefined {
		const state = this.sessions.get(sessionId);
		return state ? cloneSnapshot(state) : undefined;
	}

	delete(sessionId: string): boolean {
		return this.sessions.delete(sessionId);
	}

	cleanupBefore(cutoff: number): number {
		let removed = 0;
		for (const [sessionId, state] of this.sessions) {
			if (state.updatedAt < cutoff) {
				this.sessions.delete(sessionId);
				removed += 1;
			}
		}
		return removed;
	}

	clear(): void {
		this.sessions.clear();
	}
}
