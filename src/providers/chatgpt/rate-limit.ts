export type ChatGptModelCap = Readonly<{
	code: "model_cap_exceeded";
	retryAfterSeconds: number;
}>;

const modelCooldownUntil = new Map<string, number>();

export function parseChatGptModelCap(errorText: string): ChatGptModelCap | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(errorText);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const detail = (parsed as Record<string, unknown>).detail;
	if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return null;
	const record = detail as Record<string, unknown>;
	if (record.code !== "model_cap_exceeded") return null;
	const clearsIn = Number(record.clears_in);
	if (!Number.isFinite(clearsIn) || clearsIn <= 0) return null;
	return Object.freeze({
		code: "model_cap_exceeded",
		retryAfterSeconds: Math.max(1, Math.ceil(clearsIn)),
	});
}

export function recordChatGptModelCooldown(
	model: string,
	retryAfterSeconds: number,
	nowMs = Date.now(),
): void {
	const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
	modelCooldownUntil.set(model, nowMs + seconds * 1000);
}

export function getChatGptModelCooldown(model: string, nowMs = Date.now()): number | null {
	const until = modelCooldownUntil.get(model);
	if (until === undefined) return null;
	const remainingMs = until - nowMs;
	if (remainingMs <= 0) {
		modelCooldownUntil.delete(model);
		return null;
	}
	return Math.max(1, Math.ceil(remainingMs / 1000));
}

export function clearChatGptModelCooldowns(): void {
	modelCooldownUntil.clear();
}
