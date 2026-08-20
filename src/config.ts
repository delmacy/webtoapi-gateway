import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AgentMode = "passthrough" | "optimized";

export interface GatewayConfig {
	port: number;
	gatewayApiKey: string | undefined;
	cdpUrl: string;
	/** Per-request timeout in seconds for the /v1/chat/completions route. */
	requestTimeoutSec: number;
	agentMode: AgentMode;
	agentSessionIdleTtlSec: number;
	agentMaxToolTurns: number;
	agentMaxIdenticalToolCalls: number;
	agentToolResultMaxChars: number;
	agentPreserveTailMessages: number;
	agentMaxConcurrencyPerProvider: number;
	agentMinIntervalMs: number;
	agentTelemetry: boolean;
}

interface ConfigFile {
	port?: number;
	apiKey?: string;
	cdpUrl?: string;
	requestTimeoutSec?: number;
	agentMode?: AgentMode;
	agentSessionIdleTtlSec?: number;
	agentMaxToolTurns?: number;
	agentMaxIdenticalToolCalls?: number;
	agentToolResultMaxChars?: number;
	agentPreserveTailMessages?: number;
	agentMaxConcurrencyPerProvider?: number;
	agentMinIntervalMs?: number;
	agentTelemetry?: boolean;
}

const DEFAULTS: Required<ConfigFile> = {
	port: 3456,
	apiKey: "",
	cdpUrl: "http://127.0.0.1:9222",
	requestTimeoutSec: 300,
	agentMode: "optimized",
	agentSessionIdleTtlSec: 3600,
	agentMaxToolTurns: 40,
	agentMaxIdenticalToolCalls: 2,
	agentToolResultMaxChars: 12000,
	agentPreserveTailMessages: 6,
	agentMaxConcurrencyPerProvider: 1,
	agentMinIntervalMs: 2500,
	agentTelemetry: true,
};

export const CONFIG_FILE_PATH = join(homedir(), ".token-free-gateway", "config.json");

function loadConfigFile(): ConfigFile {
	try {
		if (existsSync(CONFIG_FILE_PATH)) {
			const raw = readFileSync(CONFIG_FILE_PATH, "utf-8");
			return JSON.parse(raw) as ConfigFile;
		}
	} catch {
		// ignore malformed or unreadable config file
	}
	return {};
}

function envBool(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function parseAgentMode(value: string | undefined, fallback: AgentMode): AgentMode {
	return value === "passthrough" || value === "optimized" ? value : fallback;
}

/**
 * Ensure config file exists and contains all known fields.
 * - If the file is missing, create it with all defaults.
 * - If the file exists but is missing fields added in newer versions,
 *   back-fill them so users can discover and edit every option.
 */
export function ensureConfigFile(): void {
	try {
		mkdirSync(dirname(CONFIG_FILE_PATH), { recursive: true });

		if (!existsSync(CONFIG_FILE_PATH)) {
			writeFileSync(CONFIG_FILE_PATH, `${JSON.stringify(DEFAULTS, null, 2)}\n`, "utf-8");
			console.log(`Created default config: ${CONFIG_FILE_PATH}`);
			return;
		}

		const raw = readFileSync(CONFIG_FILE_PATH, "utf-8");
		const existing = JSON.parse(raw) as Record<string, unknown>;
		let patched = false;
		for (const [key, value] of Object.entries(DEFAULTS)) {
			if (!(key in existing)) {
				existing[key] = value;
				patched = true;
			}
		}
		if (patched) {
			writeFileSync(CONFIG_FILE_PATH, `${JSON.stringify(existing, null, 2)}\n`, "utf-8");
			console.log(`Updated config with new fields: ${CONFIG_FILE_PATH}`);
		}
	} catch {
		// non-fatal: config file is optional
	}
}

/**
 * Load gateway configuration.
 *
 * Priority (highest to lowest):
 *   1. TFG_* environment variables
 *   2. <homedir>/.token-free-gateway/config.json
 *   3. Built-in defaults
 */
export function loadConfig(): GatewayConfig {
	const file = loadConfigFile();
	const fileMode = file.agentMode ?? DEFAULTS.agentMode;
	const fileTelemetry = file.agentTelemetry ?? DEFAULTS.agentTelemetry;
	return {
		port: Number.parseInt(process.env.TFG_PORT ?? String(file.port ?? DEFAULTS.port), 10),
		gatewayApiKey: (process.env.TFG_API_KEY ?? file.apiKey ?? DEFAULTS.apiKey) || undefined,
		cdpUrl: process.env.TFG_CDP_URL ?? file.cdpUrl ?? DEFAULTS.cdpUrl,
		requestTimeoutSec: Number.parseInt(
			process.env.TFG_REQUEST_TIMEOUT_SEC ??
				String(file.requestTimeoutSec ?? DEFAULTS.requestTimeoutSec),
			10,
		),
		agentMode: parseAgentMode(process.env.TFG_AGENT_MODE, fileMode),
		agentSessionIdleTtlSec: Number.parseInt(
			process.env.TFG_AGENT_SESSION_IDLE_TTL_SEC ??
				String(file.agentSessionIdleTtlSec ?? DEFAULTS.agentSessionIdleTtlSec),
			10,
		),
		agentMaxToolTurns: Number.parseInt(
			process.env.TFG_AGENT_MAX_TOOL_TURNS ?? String(file.agentMaxToolTurns ?? DEFAULTS.agentMaxToolTurns),
			10,
		),
		agentMaxIdenticalToolCalls: Number.parseInt(
			process.env.TFG_AGENT_MAX_IDENTICAL_TOOL_CALLS ??
				String(file.agentMaxIdenticalToolCalls ?? DEFAULTS.agentMaxIdenticalToolCalls),
			10,
		),
		agentToolResultMaxChars: Number.parseInt(
			process.env.TFG_AGENT_TOOL_RESULT_MAX_CHARS ??
				String(file.agentToolResultMaxChars ?? DEFAULTS.agentToolResultMaxChars),
			10,
		),
		agentPreserveTailMessages: Number.parseInt(
			process.env.TFG_AGENT_PRESERVE_TAIL_MESSAGES ??
				String(file.agentPreserveTailMessages ?? DEFAULTS.agentPreserveTailMessages),
			10,
		),
		agentMaxConcurrencyPerProvider: Number.parseInt(
			process.env.TFG_AGENT_MAX_CONCURRENCY_PER_PROVIDER ??
				String(file.agentMaxConcurrencyPerProvider ?? DEFAULTS.agentMaxConcurrencyPerProvider),
			10,
		),
		agentMinIntervalMs: Number.parseInt(
			process.env.TFG_AGENT_MIN_INTERVAL_MS ??
				String(file.agentMinIntervalMs ?? DEFAULTS.agentMinIntervalMs),
			10,
		),
		agentTelemetry: envBool(process.env.TFG_AGENT_TELEMETRY, fileTelemetry),
	};
}
