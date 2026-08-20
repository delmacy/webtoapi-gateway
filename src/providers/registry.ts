/**
 * Provider registry: maps provider IDs and model names to WebProviderClient factories.
 * All 13 Web AI providers are registered here with their model catalogs.
 */

import { getCredentials } from "./auth-store.ts";
import { SessionScopedProviderClient } from "./session-scoped-client.ts";
import type {
	ModelInfo,
	ProviderDefinition,
	ProviderSessionCapabilities,
	WebProviderClient,
} from "./types.ts";

// Lazy-loaded provider definitions to avoid importing all providers at startup
let _definitions: ProviderDefinition[] | null = null;

async function loadDefinitions(): Promise<ProviderDefinition[]> {
	if (_definitions) return _definitions;

	const [
		claude,
		chatgpt,
		deepseek,
		doubao,
		gemini,
		glm,
		glmIntl,
		grok,
		kimi,
		perplexity,
		qwen,
		qwenCn,
		xiaomimo,
	] = await Promise.all([
		import("./claude/index.ts"),
		import("./chatgpt/index.ts"),
		import("./deepseek/index.ts"),
		import("./doubao/index.ts"),
		import("./gemini/index.ts"),
		import("./glm/index.ts"),
		import("./glm-intl/index.ts"),
		import("./grok/index.ts"),
		import("./kimi/index.ts"),
		import("./perplexity/index.ts"),
		import("./qwen/index.ts"),
		import("./qwen-cn/index.ts"),
		import("./xiaomimo/index.ts"),
	]);

	_definitions = [
		claude.definition,
		chatgpt.definition,
		deepseek.definition,
		doubao.definition,
		gemini.definition,
		glm.definition,
		glmIntl.definition,
		grok.definition,
		kimi.definition,
		perplexity.definition,
		qwen.definition,
		qwenCn.definition,
		xiaomimo.definition,
	];
	return _definitions;
}

const clientCache = new Map<string, WebProviderClient>();

const SESSION_SCOPED_CAPABILITIES: Record<string, ProviderSessionCapabilities> = {
	"deepseek-web": {
		persistentConversation: true,
		deltaPrompts: true,
		resettable: true,
	},
	"chatgpt-web": {
		persistentConversation: true,
		deltaPrompts: false,
		resettable: true,
	},
};

/**
 * Evict a cached provider client so the next `getProviderClient` call
 * re-reads credentials from disk and creates a fresh instance.
 * Called automatically when a SessionExpiredError is thrown.
 */
export function evictProviderClient(providerId: string): void {
	const old = clientCache.get(providerId);
	if (old) {
		old.close?.().catch(() => {});
		clientCache.delete(providerId);
		console.log(`[registry] Evicted cached client for "${providerId}"`);
	}
}

/**
 * Get or create a provider client for the given provider ID.
 * Returns null if no credentials are stored for this provider.
 */
export async function getProviderClient(providerId: string): Promise<WebProviderClient | null> {
	if (clientCache.has(providerId)) return clientCache.get(providerId)!;

	const creds = getCredentials(providerId);
	if (!creds) return null;

	const defs = await loadDefinitions();
	const def = defs.find((d) => d.id === providerId);
	if (!def) return null;

	const sessionCapabilities = SESSION_SCOPED_CAPABILITIES[providerId];
	const client = sessionCapabilities
		? new SessionScopedProviderClient(def.id, def.models, creds, def.factory, sessionCapabilities)
		: def.factory(creds);
	await client.init();
	clientCache.set(providerId, client);
	return client;
}

/**
 * Resolve a model name to a provider ID.
 * Supports both direct model IDs ("claude-sonnet-4-6") and
 * prefixed format ("claude-web/claude-sonnet-4-6").
 */
export async function resolveModelToProvider(model: string): Promise<string | null> {
	const defs = await loadDefinitions();

	// Check prefixed format: "provider-id/model-id"
	if (model.includes("/")) {
		const providerId = model.split("/")[0];
		if (defs.some((d) => d.id === providerId)) return providerId!;
	}

	// Search all providers for matching model ID
	for (const def of defs) {
		if (def.models.some((m) => m.id === model)) return def.id;
	}

	return null;
}

/**
 * Get the client for a specific model name.
 */
export async function getClientForModel(model: string): Promise<WebProviderClient | null> {
	const providerId = await resolveModelToProvider(model);
	if (!providerId) return null;
	return getProviderClient(providerId);
}

/**
 * List all models from all authenticated providers.
 */
export async function listAllModels(): Promise<ModelInfo[]> {
	const defs = await loadDefinitions();
	const models: ModelInfo[] = [];
	for (const def of defs) {
		const creds = getCredentials(def.id);
		if (!creds) continue;
		models.push(...def.models);
	}
	return models;
}

/**
 * List all provider definitions (for webauth wizard).
 */
export async function listProviderDefinitions(): Promise<ProviderDefinition[]> {
	return loadDefinitions();
}

/**
 * Clear a cached provider client (e.g. after re-authentication).
 */
export function clearProviderCache(providerId: string): void {
	const client = clientCache.get(providerId);
	if (client?.close) client.close();
	clientCache.delete(providerId);
}

const SESSION_CHECK_TIMEOUT_MS = 10_000;

/**
 * Check session status for all cached provider clients that support it.
 * Each check is guarded by a 10 s timeout so /health never hangs.
 */
export async function checkAllSessions(): Promise<
	Record<string, { valid: boolean; reason?: string }>
> {
	const results: Record<string, { valid: boolean; reason?: string }> = {};
	const entries = [...clientCache.entries()];
	await Promise.all(
		entries.map(async ([id, client]) => {
			if (!client.checkSession) {
				results[id] = { valid: true, reason: "unchecked" };
				return;
			}
			try {
				const race = Promise.race([
					client.checkSession(),
					new Promise<{ valid: false; reason: string }>((resolve) =>
						setTimeout(
							() => resolve({ valid: false, reason: "session check timed out" }),
							SESSION_CHECK_TIMEOUT_MS,
						),
					),
				]);
				results[id] = await race;
			} catch (err) {
				results[id] = { valid: false, reason: err instanceof Error ? err.message : String(err) };
			}
		}),
	);
	return results;
}
