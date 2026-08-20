export type RuntimeTransport = "json" | "sse" | "connect-rpc" | "dom" | "unknown";

export interface ProviderRuntimeProfile {
	providerId: string;
	origin?: string;
	endpoint?: string;
	transport?: RuntimeTransport;
	model?: string;
	scenario?: string;
	conversationId?: string;
	capabilities?: string[];
	requestMethod?: string;
	clientVersion?: string;
	requestKeys?: string[];
	lastObservedAt: number;
	source: "network" | "response" | "probe" | "fallback";
}

class RuntimeProfileStore {
	private static instance: RuntimeProfileStore | null = null;
	private readonly profiles = new Map<string, ProviderRuntimeProfile>();

	static getInstance(): RuntimeProfileStore {
		if (!RuntimeProfileStore.instance) RuntimeProfileStore.instance = new RuntimeProfileStore();
		return RuntimeProfileStore.instance;
	}

	get(providerId: string): ProviderRuntimeProfile | undefined {
		return this.profiles.get(providerId);
	}

	update(providerId: string, patch: Partial<ProviderRuntimeProfile>): ProviderRuntimeProfile {
		const previous = this.profiles.get(providerId);
		const next: ProviderRuntimeProfile = {
			...previous,
			...patch,
			providerId,
			source: patch.source ?? previous?.source ?? "fallback",
			lastObservedAt: Date.now(),
		};
		this.profiles.set(providerId, next);
		return next;
	}

	all(): ProviderRuntimeProfile[] {
		return [...this.profiles.values()];
	}
}

export const runtimeProfiles = RuntimeProfileStore.getInstance();
