# Agentic mode

The fork adds an optional optimization layer for long-running OpenAI-compatible agent workflows such as OpenCode.

## Goals

- keep the existing `/v1/chat/completions` contract unchanged;
- reduce repeated prompt/context overhead without modifying provider adapters prematurely;
- serialize browser-backed providers conservatively by default;
- detect runaway tool loops;
- expose context-savings telemetry;
- preserve a true passthrough mode for upstream-compatible behavior.

## Default policy

```env
TFG_AGENT_MODE=optimized
TFG_AGENT_SESSION_IDLE_TTL_SEC=3600
TFG_AGENT_MAX_TOOL_TURNS=40
TFG_AGENT_MAX_IDENTICAL_TOOL_CALLS=2
TFG_AGENT_TOOL_RESULT_MAX_CHARS=12000
TFG_AGENT_PRESERVE_TAIL_MESSAGES=6
TFG_AGENT_MAX_CONCURRENCY_PER_PROVIDER=1
TFG_AGENT_MIN_INTERVAL_MS=2500
TFG_AGENT_TELEMETRY=true
```

The fair-use governor does not rotate accounts, bypass CAPTCHA, suppress upstream 429 responses, or attempt to evade provider cooldowns. The default is one active request per provider with a minimum delay between request starts.

## Context optimization

In optimized mode, large historical tool results are compacted while recent messages are preserved verbatim. Tool schemas are rendered in a compact signature-oriented format to avoid repeatedly sending long OpenCode JSON-schema descriptions.

A logical session id is derived for repeated agent turns and propagated through the provider interface. Provider-specific reuse of real upstream `chat_id` / `conversation_id` values is intentionally not enabled yet; each provider needs live end-to-end verification before changing its conversation semantics.

Responses expose:

- `x-webtoapi-session-id`
- `x-webtoapi-saved-context-chars`

The `/health` endpoint also includes agent-mode telemetry.

## Passthrough mode

Set:

```env
TFG_AGENT_MODE=passthrough
```

Passthrough mode disables context compaction, loop guards, fair-use scheduling, and compact tool-schema rendering so the request path behaves like the upstream project.

## Validation

Before merging changes to the agent layer, run:

```bash
bun install --frozen-lockfile
bunx @biomejs/biome check .
bunx tsc --noEmit
bun test
```

For OpenCode E2E verification, start with a multi-step read-only task (`Glob -> Read -> final response`) before testing edits and shell commands.