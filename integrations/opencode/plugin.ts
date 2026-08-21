type MutableRecord = Record<string, any>;

type PluginOptions = {
	baseURL?: string;
	apiKey?: string;
	providerID?: string;
	compaction?: boolean;
	prune?: boolean;
	tailTurns?: number;
};

type PluginInput = {
	directory: string;
	worktree: string;
	serverUrl: URL;
};

type ChatHookInput = {
	sessionID: string;
	agent: string;
	model: { providerID?: string; id?: string };
	provider: {
		info?: { id?: string };
	};
	message: { id?: string };
};

type Hooks = {
	config?: (config: MutableRecord) => Promise<void> | void;
	"chat.headers"?: (
		input: ChatHookInput,
		output: { headers: Record<string, string> },
	) => Promise<void> | void;
	"experimental.chat.system.transform"?: (
		input: { sessionID?: string; model: { providerID?: string } },
		output: { system: string[] },
	) => Promise<void> | void;
	"experimental.session.compacting"?: (
		input: { sessionID: string },
		output: { context: string[]; prompt?: string },
	) => Promise<void> | void;
	"experimental.compaction.autocontinue"?: (
		input: { sessionID: string; model: { providerID?: string }; provider: { info?: { id?: string } } },
		output: { enabled: boolean },
	) => Promise<void> | void;
};

const DEFAULT_MODELS = {
	"qwen3.5-plus": { name: "Qwen" },
	"moonshot-v1-32k": { name: "Kimi" },
	"deepseek-chat": { name: "DeepSeek" },
	"gpt-4": { name: "ChatGPT" },
};

const DURABLE_SYSTEM = `WebToAPI/OpenCode durable execution rules:
- Treat the OpenCode session as the durable source of truth for task state, tool results, permissions, retries, and compaction.
- Continue from real tool results until the user's requested task is actually complete; a successful tool call is not itself task completion.
- Preserve the original task goal, explicit constraints, selected repository/workspace, modified files, validation status, unresolved failures, and next required action across long runs.
- When a target is materially ambiguous and the question tool is available, ask instead of silently choosing a repository, workspace, branch, package, or file.
- Never claim a validation, edit, command, or test succeeded unless its real tool result supports that claim.
- If execution cannot safely continue, stop with a concrete blocking reason rather than guessing or fabricating progress.`;

const COMPACTION_CONTEXT = `When compacting this OpenCode session, preserve a durable execution checkpoint. The summary must retain, when applicable:
1. the original user goal and current subtask;
2. explicit constraints, permissions, allowed/forbidden paths, and acceptance criteria;
3. the selected repository/workspace/branch and why it was selected;
4. files already inspected or modified and the important facts learned from them;
5. real tool results that materially affect the next decision, including failures;
6. tests, typechecks, lint, builds, git status/diff, or other validation already run and their actual outcomes;
7. unresolved errors, blockers, hypotheses still requiring evidence, and pending user questions;
8. the exact next action needed to continue safely;
9. any IDs or relationships needed to correlate parent/subagent work.
Do not turn an unfinished task into a completed one during compaction. Prefer a concise operational checkpoint over narrative history.`;

function isWebToAPI(input: {
	model?: { providerID?: string };
	provider?: { info?: { id?: string } };
}, providerID: string): boolean {
	return input.model?.providerID === providerID || input.provider?.info?.id === providerID;
}

function mergeObject(target: MutableRecord | undefined, source: MutableRecord): MutableRecord {
	return { ...(target ?? {}), ...source };
}

export default async function webToAPIOpenCodePlugin(
	_input: PluginInput,
	options: PluginOptions = {},
): Promise<Hooks> {
	const providerID = options.providerID?.trim() || "webtoapi";
	const baseURL = options.baseURL?.trim() || "http://127.0.0.1:3456/v1";
	const apiKey = options.apiKey ?? "unused";
	const enableCompaction = options.compaction ?? true;
	const enablePrune = options.prune ?? true;
	const tailTurns = Math.max(2, Math.floor(options.tailTurns ?? 15));

	return {
		config(config) {
			config.provider ??= {};
			const existing = config.provider[providerID] ?? {};
			config.provider[providerID] = {
				...existing,
				npm: existing.npm ?? "@ai-sdk/openai-compatible",
				name: existing.name ?? "WebToAPI Gateway",
				options: mergeObject(existing.options, {
					baseURL,
					apiKey,
				}),
				models: mergeObject(DEFAULT_MODELS, existing.models),
			};

			if (enableCompaction) {
				config.compaction = {
					...(config.compaction ?? {}),
					auto: config.compaction?.auto ?? true,
					prune: config.compaction?.prune ?? enablePrune,
					tail_turns: config.compaction?.tail_turns ?? tailTurns,
				};
			}
		},

		"chat.headers"(input, output) {
			if (!isWebToAPI(input, providerID)) return;
			// Canonical gateway affinity header. OpenCode also sends X-Session-Id and
			// x-session-affinity for custom providers, but this explicit header keeps
			// the integration stable if OpenCode's internal header names change.
			output.headers["x-webtoapi-session-id"] = input.sessionID;
			if (input.message.id) output.headers["x-webtoapi-request-id"] = input.message.id;
			output.headers["x-webtoapi-client"] = "opencode-plugin";
		},

		"experimental.chat.system.transform"(input, output) {
			if (input.model.providerID !== providerID) return;
			if (!output.system.some((item) => item.includes("WebToAPI/OpenCode durable execution rules:"))) {
				output.system.push(DURABLE_SYSTEM);
			}
		},

		"experimental.session.compacting"(_input, output) {
			if (!output.context.includes(COMPACTION_CONTEXT)) output.context.push(COMPACTION_CONTEXT);
		},

		"experimental.compaction.autocontinue"(input, output) {
			if (!isWebToAPI(input, providerID)) return;
			// A compaction checkpoint is an internal continuity operation, not task
			// completion. Let OpenCode synthesize its normal continue turn.
			output.enabled = true;
		},
	};
}
