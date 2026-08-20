export interface FairUsePolicy {
	maxConcurrency: number;
	minIntervalMs: number;
}

type Release = () => void;

type QueueEntry = {
	policy: FairUsePolicy;
	resolve: (release: Release) => void;
};

type ProviderState = {
	active: number;
	lastStartedAt: number;
	queue: QueueEntry[];
	timer: ReturnType<typeof setTimeout> | null;
};

/**
 * Conservative per-provider scheduler.
 *
 * It deliberately serializes browser-backed providers by default and inserts
 * a minimum interval between request starts. This is not a bypass mechanism:
 * upstream 429/cooldown responses still propagate to the caller unchanged.
 */
export class FairUseGovernor {
	private readonly states = new Map<string, ProviderState>();

	async acquire(providerId: string, policy: FairUsePolicy): Promise<Release> {
		const normalized: FairUsePolicy = {
			maxConcurrency: Math.max(1, Math.floor(policy.maxConcurrency)),
			minIntervalMs: Math.max(0, Math.floor(policy.minIntervalMs)),
		};
		const state = this.getState(providerId);
		return new Promise<Release>((resolve) => {
			state.queue.push({ policy: normalized, resolve });
			this.drain(providerId);
		});
	}

	getStats(providerId: string): { active: number; queued: number; lastStartedAt: number } {
		const state = this.getState(providerId);
		return {
			active: state.active,
			queued: state.queue.length,
			lastStartedAt: state.lastStartedAt,
		};
	}

	private getState(providerId: string): ProviderState {
		let state = this.states.get(providerId);
		if (!state) {
			state = { active: 0, lastStartedAt: 0, queue: [], timer: null };
			this.states.set(providerId, state);
		}
		return state;
	}

	private drain(providerId: string): void {
		const state = this.getState(providerId);
		if (state.timer || state.queue.length === 0) return;

		const next = state.queue[0];
		if (!next) return;
		if (state.active >= next.policy.maxConcurrency) return;

		const waitMs = Math.max(0, next.policy.minIntervalMs - (Date.now() - state.lastStartedAt));
		if (waitMs > 0) {
			state.timer = setTimeout(() => {
				state.timer = null;
				this.drain(providerId);
			}, waitMs);
			return;
		}

		state.queue.shift();
		state.active += 1;
		state.lastStartedAt = Date.now();
		let released = false;
		next.resolve(() => {
			if (released) return;
			released = true;
			state.active = Math.max(0, state.active - 1);
			this.drain(providerId);
		});

		// If maxConcurrency > 1, fill the remaining capacity as well.
		queueMicrotask(() => this.drain(providerId));
	}
}

export const fairUseGovernor = new FairUseGovernor();
