# 2026-09-09 — L06 end-to-end cycle through the real HTTP adapter

Branch: `feat/live-author-studio`
Baseline for this slice: `b018f41` (L05 commit).

## Result

`apps/studio/test/live-author-full-http-cycle.test.mjs` (1/1) — a SQLite-backed full stack (real Control HTTP server + real Studio proxy + real settings endpoint + real `LocalAuthorProvider`/`ModelProviderAgentBackend`/`OpenAiCompatibleModelProvider` + real Player launcher), with the network stubbed only at the provider boundary:

1. project + quest with one location through the proxy;
2. provider configured through the same `POST /local/author-provider` the form uses (`settings_saved`, no upstream call);
3. first segment: Bearer credential, model and JSON response format reach the upstream stub; proposal adds linked `blue-paint` (initialValue 6) + `paint-wall` (cost 1);
4. draft unchanged before Apply; Apply creates revision 1; repeated Apply with the same idempotency key creates no second revision;
5. correction turn: the stub-verified context message contains the created `blue-paint`/`paint-wall` blocks with `draftRevision:1`; proposal replaces the existing action with `resourceUnitsPerUnit: 2` (no duplicate id); Apply → revision 2;
6. validate → freeze → `POST /local/launch-player` → real Player → runtime session → paint 1 unit consumes 2 (the frozen cost-2 rule) leaving 4;
7. draft changed after freeze (cost→5); the running Player still consumes 2 → remaining 2 — the frozen rule is untouched by draft edits;
8. provider invalid JSON (`AUTHOR_BACKEND_INVALID_RESPONSE`) and 429 (`AUTHOR_BACKEND_RATE_LIMITED`, on a fresh job — a failed job is terminal by contract) leave draft, frozen playtest and provider state consistent (`state:"error"`, `lastErrorCode` set).

## Evidence notes

- the test catches the scripted-wiring class of bugs: settings/proxy/apply all run over HTTP with the same endpoints the browser uses;
- the run asserts "интеграция с HTTP stub", not "проверена реальная модель" — live acceptance stays with L08.

## Verification

- `npm run typecheck` — exit 0;
- the L06 file — exit 0, 1/1;
- `apps/studio` group — 57/61 (the same 4 pre-existing B05/B10-era failures);
- `apps/server` + `packages/player` + `packages/control` + `packages/ai` groups — exit 0, 287/287;
- no paid API call; Node `24.18.0` vs `>=24.19.0 <25` remains an environment limitation.

## Acceptance

L06 accepted on the end-to-end evidence above: settings → linked blocks → Apply → correction → Apply → validate → freeze → Player painting against the frozen rule, with failure isolation.

Next card: L07 — browser acceptance (desktop and 360 px) with actionable errors.
