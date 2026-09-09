# 2026-09-09 — L02 ModelProvider to AgentBackend

Branch: `feat/live-author-studio`
Baseline for this slice: `1bc76c1facbb84ea573f7e29908dfa1d7bc5cb7b`

## Result

Completed the server-owned `ModelProvider` to no-tools `AgentBackend` bridge:

- bounded profile/deadline/message/output validation uses an injectable clock;
- every turn calls the configured provider with the selected model, original bounded messages, JSON-object response format and output budget;
- provider 401/403, 429, timeout, abort, invalid JSON and network outcomes map to the existing AgentBackend error contract;
- usage and provider request IDs remain available when the provider reports them, including structured failure results;
- per-turn cancellation no longer permanently aborts a session, while close/disconnect/rotation invalidates old handles and aborts in-flight work;
- busy sessions and the eight-session cap fail closed; malformed output never becomes an author proposal.

## Verification

- `npm run typecheck` — exit 0;
- focused L02 + existing AgentBackend/provider tests — exit 0, 15/15 pass;
- `npm run test:ai` — exit 0, 46/46 pass;
- real `OpenAiCompatibleModelProvider` boundary was exercised with fetch-only stubs; no paid API was called;
- assertions cover request URL/headers/body, JSON format, output budget, error mapping, usage/request ID, cancel, deadline, busy, session cap, close and rotation race;
- safe view remains no-tools and exposes no gameplay mutation fields.

Node `24.18.0` is below the repository's required `>=24.19.0 <25`; this remains an environment limitation, not a product failure.

## Acceptance

L02 accepted on the evidence above. Next card: L03 — Studio provider configuration lifecycle and user-facing states.
