import type { Page } from "playwright-core";
import type { BrowserCookie } from "../shared/cookie-parser.ts";
import { throwIfSessionExpired } from "../shared/error-guard.ts";
import type { EvalResult } from "../shared/eval-helpers.ts";
import { ensurePage } from "../shared/page-lifecycle.ts";
import { textToStream } from "../shared/stream-helpers.ts";
import type { ModelInfo, ProviderSendParams, StreamResult, WebProviderClient } from "../types.ts";
import { ProviderApiError } from "../types.ts";
import type { ApiClientConfig, NormalizedSendParams } from "./types.ts";

/**
 * Abstract base class for API-based web providers.
 *
 * Subclasses supply the provider-specific `callApi()` logic while the
 * base handles page lifecycle, error routing, stream wrapping, and
 * model listing.
 *
 * @typeParam TAuth - The credential shape returned by `getCredentials()`.
 */
export abstract class BaseApiClient<TAuth = unknown> implements WebProviderClient {
	abstract readonly providerId: string;
	protected abstract readonly config: ApiClientConfig;

	protected page: Page | null = null;
	protected readonly auth: TAuth;

	constructor(auth: TAuth) {
		this.auth = auth;
	}

	protected abstract getCookies(): BrowserCookie[];
	protected abstract callApi(page: Page, params: NormalizedSendParams): Promise<EvalResult>;
	protected abstract parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult>;

	protected async onInit(): Promise<void> {}

	protected async handleError(
		err: Error,
		_page: Page,
		_params: NormalizedSendParams,
	): Promise<ReadableStream<Uint8Array> | null> {
		throw err;
	}

	async init(): Promise<void> {
		await this.getPage();
		await this.onInit();
	}

	async sendMessage(params: ProviderSendParams): Promise<ReadableStream<Uint8Array>> {
		const page = await this.getPage();
		const normalized: NormalizedSendParams = {
			message: params.message,
			model: params.model || this.config.defaultModel,
			signal: params.signal,
			sessionId: params.sessionId,
			sessionEpoch: params.sessionEpoch,
			resetSession: params.resetSession,
			statefulSession: params.statefulSession,
			rehydrationMessage: params.rehydrationMessage,
		};

		try {
			const result = await this.callApi(page, normalized);
			if (!result.ok) {
				throwIfSessionExpired(this.providerId, result.status);
				const msg = `${this.providerId} API error: ${result.status} - ${result.error}`;
				if (result.status && result.status >= 400 && result.status < 500) {
					throw new ProviderApiError(result.status, msg);
				}
				throw new Error(msg);
			}
			return textToStream(result.data);
		} catch (err) {
			const fallback = await this.handleError(err as Error, page, normalized);
			if (fallback) return fallback;
			throw err;
		}
	}

	async parseStream(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return this.parseStreamImpl(body, onDelta);
	}

	listModels(): ModelInfo[] {
		return this.config.models;
	}

	async close(): Promise<void> {
		this.page = null;
	}

	protected async getPage(): Promise<Page> {
		this.page = await ensurePage(this.page, {
			hostKey: this.config.hostKey,
			startUrl: this.config.startUrl,
			cookies: this.getCookies(),
		});
		return this.page;
	}
}
