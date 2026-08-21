# WebToAPI OpenCode plugin

This integration makes OpenCode the durable task/session owner and WebToAPI the browser-backed inference bridge.

## Responsibilities

OpenCode remains responsible for:

- durable logical sessions and transcripts;
- tool execution and permissions;
- retry/backoff;
- task/subagent orchestration;
- compaction and pruning;
- continuation after compaction.

WebToAPI remains responsible for:

- mapping the stable OpenCode session to an upstream web conversation;
- full/delta/rehydrate prompt delivery;
- `GW_AGENT_PROTOCOL/1` serialization and validation;
- protocol repair for serialization-only failures;
- tool-call schema validation;
- idempotent response caching;
- provider fair-use scheduling.

## What the plugin adds

`plugin.ts`:

1. registers the `webtoapi` OpenAI-compatible provider;
2. registers one tested model alias for Qwen, Kimi, DeepSeek, and ChatGPT;
3. sends `x-webtoapi-session-id` with the real OpenCode `sessionID`;
4. enables durable compaction/pruning defaults without overriding explicit user choices;
5. adds a compact system contract for long-running repository work;
6. enriches OpenCode compaction summaries with an operational checkpoint;
7. keeps OpenCode's normal auto-continue behavior after compaction.

The gateway also accepts OpenCode's native custom-provider affinity headers (`x-session-affinity` and `X-Session-Id`) as a fallback. The explicit plugin header is preferred because it is part of the WebToAPI integration contract rather than an OpenCode internal convention.

## Install in a project

Copy or reference `plugin.ts`, then add it to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "./integrations/opencode/plugin.ts",
      {
        "baseURL": "http://127.0.0.1:3456/v1",
        "compaction": true,
        "prune": true,
        "tailTurns": 15
      }
    ]
  ]
}
```

OpenCode loads config/plugins at startup, so restart the CLI after changing the plugin or config.

## Global install

The plugin can also be referenced by an absolute file URL from the global OpenCode config. On Windows, for example:

```json
{
  "plugin": [
    [
      "file:///C:/Users/admin/webtoapi-gateway/integrations/opencode/plugin.ts",
      {
        "baseURL": "http://127.0.0.1:3456/v1"
      }
    ]
  ]
}
```

The global config is normally under `~/.config/opencode/opencode.json` or `opencode.jsonc`.

## Models registered by default

Only aliases already exercised through this gateway are registered:

- `webtoapi/qwen3.5-plus` — Qwen
- `webtoapi/moonshot-v1-32k` — Kimi
- `webtoapi/deepseek-chat` — DeepSeek
- `webtoapi/gpt-4` — ChatGPT

Existing user-defined models are preserved and merged with these defaults.

## Session behavior

For each WebToAPI inference the plugin sends:

```text
x-webtoapi-session-id: <OpenCode sessionID>
x-webtoapi-request-id: <OpenCode user message ID, when available>
x-webtoapi-client: opencode-plugin
```

OpenCode itself also currently emits `x-session-affinity` and `X-Session-Id` for custom providers. The gateway recognizes all of them, with this precedence:

```text
x-webtoapi-session-id
x-opencode-session
x-session-affinity
x-session-id
body/user/auto fallback
```

A real OpenCode session therefore becomes `stable=true`, enabling provider conversation reuse when the selected web provider supports persistent sessions.

## Durable compaction

The plugin leaves OpenCode in charge of compaction. By default it fills these values only when the user did not already configure them:

```json
{
  "compaction": {
    "auto": true,
    "prune": true,
    "tail_turns": 15
  }
}
```

Before compaction, the plugin asks OpenCode to preserve an operational checkpoint containing the original goal, constraints, selected workspace, modified/inspected files, material tool results, validation outcomes, unresolved errors, pending questions, and the exact next action.

This is deliberately different from having the gateway summarize context. OpenCode owns the authoritative transcript and knows which tool results, permissions, parent/subagent relationships, and task state must survive.

## Expected gateway log

With the plugin active, a multi-turn tool task should move from unstable auto identity:

```text
session=auto:... source=auto stable=false
```

to a stable session:

```text
[request-headers] x-webtoapi-session-id=ses_...
[agent] session=explicit:ses_... source=override stable=true ... history=initial
[agent] session=explicit:ses_... source=override stable=true ... history=append
```

For providers with persistent-conversation capability, subsequent append turns should use delta prompts and the same upstream conversation instead of creating a new chat each time.

## Safety boundary

The plugin intentionally does not execute gateway actions, bypass OpenCode permissions, implement a second retry loop, or perform its own transcript compaction. Those remain OpenCode responsibilities. The gateway continues to fail closed on unknown tools, invalid arguments, and semantic protocol violations.
