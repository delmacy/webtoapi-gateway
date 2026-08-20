import type {
	ModelInfo,
	ProviderSendParams,
	ProviderSessionCapabilities,
	StreamResult,
	WebProviderClient,
	WebProviderFactory,
} from "./types.ts";

type ScopedClient = {
	epoch: number;
	client: WebProviderClient;
	lastUsedAt: number;
};

type StreamOwner = {
	client: WebProviderClient;
	ephemeral: boolean;
};

/**
 * Isolates mutable provider conversation state by logical gateway session.
 *
 * Existing provider adapters keep their native conversationId/chatSessionId
 * fields, but each logical session receives a distinct adapter instance. This
 * prevents cross-session contamination without requiring every adapter to be
 * rewritten at once.
 */
export class SessionScopedProviderClient implements WebProviderClient {
	readonly sessionCapabilities: ProviderSessionCapabilities;
	private readonly scopedClients = new Map<string, ScopedClient>();
	private readonly streamOwners = new WeakMap<ReadableStream<Uint8Array>, StreamOwner>();
	private probeClient: WebProviderClient | undefined;

	constructor(
		readonly providerId: string,
		private readonly models: ModelInfo[],
		private readonly credentials: unknown,
		private readonly factory: WebProviderFactory,
		capabilities: ProviderSessionCapabilities,
		private readonly idleTtlMs = 60 * 60 * 1000,
	) {
		this.sessionCapabilities = capabilities;
	}

	async init(): Promise<void> {
		// Session-specific clients are initialized lazily on first use. Avoid
		// creating an upstream conversation merely because the registry loaded.
	}

	listModels(): ModelInfo[] {
		return this.models.map((model) => ({ ...model }));
	}

	async sendMessage(params: ProviderSendParams): Promise<ReadableStream<Uint8Array>> {
		await this.cleanupIdle();
		const canReuse = params.statefulSession === true && Boolean(params.sessionId?.trim());
		if (!canReuse) {
			const client = this.factory(this.credentials);
			await client.init();
			try {
				const stream = await client.sendMessage({
					message: params.message,
					model: params.model,
					signal: params.signal,
				});
				this.streamOwners.set(stream, { client, ephemeral: true });
				return stream;
			} catch (error) {
				await client.close?.().catch(() => {});
				throw error;
			}
		}

		const sessionId = params.sessionId!.trim();
		const epoch = params.sessionEpoch ?? 1;
		let scoped = this.scopedClients.get(sessionId);
		if (!scoped || scoped.epoch !== epoch || params.resetSession) {
			if (scoped) await scoped.client.close?.().catch(() => {});
			const client = this.factory(this.credentials);
			await client.init();
			scoped = { epoch, client, lastUsedAt: Date.now() };
			this.scopedClients.set(sessionId, scoped);
		}

		scoped.lastUsedAt = Date.now();
		const stream = await scoped.client.sendMessage({
			message: params.message,
			model: params.model,
			signal: params.signal,
			sessionId,
		});
		this.streamOwners.set(stream, { client: scoped.client, ephemeral: false });
		return stream;
	}

	async parseStream(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		const owner = this.streamOwners.get(body);
		if (!owner) throw new Error(`${this.providerId}: response stream has no session owner`);
		try {
			return await owner.client.parseStream(body, onDelta);
		} finally {
			this.streamOwners.delete(body);
			if (owner.ephemeral) await owner.client.close?.().catch(() => {});
		}
	}

	async checkSession(): Promise<{ valid: boolean; reason?: string }> {
		if (!this.probeClient) {
			this.probeClient = this.factory(this.credentials);
			await this.probeClient.init();
		}
		if (!this.probeClient.checkSession) return { valid: true, reason: "unchecked" };
		return this.probeClient.checkSession();
	}

	async close(): Promise<void> {
		const clients = [...this.scopedClients.values()].map((entry) => entry.client);
		this.scopedClients.clear();
		await Promise.all(clients.map((client) => client.close?.().catch(() => {})));
		if (this.probeClient) await this.probeClient.close?.().catch(() => {});
		this.probeClient = undefined;
	}

	private async cleanupIdle(now = Date.now()): Promise<void> {
		const cutoff = now - this.idleTtlMs;
		const expired: WebProviderClient[] = [];
		for (const [sessionId, scoped] of this.scopedClients) {
			if (scoped.lastUsedAt < cutoff) {
				this.scopedClients.delete(sessionId);
				expired.push(scoped.client);
			}
		}
		await Promise.all(expired.map((client) => client.close?.().catch(() => {})));
	}
}
