# Qwen stateful validation

Local authenticated validation only. Keep the gateway running against the owner's logged-in Chrome/CDP session, then run:

```bash
bun run e2e:qwen-stateful
bun run e2e:qwen-isolation
```

Expected stateful flow:
- initial request: `history=initial`, `mode=full`, `stateful=true`
- exact retry: response cache hit, no duplicate upstream turn
- continuation: same upstream Qwen chat, `history=append`, `mode=delta`
- divergent history: new session epoch and fresh upstream Qwen chat
- another logical session keeps its own Qwen chat and epoch

The Qwen adapter stores the upstream `chatId` in the session-scoped provider instance. After each completion it reads `/api/v2/chats/{chatId}/` and records the latest assistant message ID as the parent for the next delta turn. If a new assistant ID cannot be observed, stateful execution fails closed instead of silently creating a broken continuation.
