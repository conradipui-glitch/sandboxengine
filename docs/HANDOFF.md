# Передача работы

Обновлено: 2026-09-09

Текущий блок: **L04 — контекст и формат ответа; L00–L03 приняты; B12 опубликован**  
Рабочая ветка: `feat/live-author-studio`. Задание: [LIVE-AUTHOR-COMPLETION.md](tasks/LIVE-AUTHOR-COMPLETION.md). L00–L02 подтверждены свежими проверками; L03 принят 2026-09-09. B13 отложен за этот маршрут.

## L00 — baseline review (2026-09-09)

- база: `6f2ad73fca228c60361012250b72609447edc968`;
- HEAD: `1bc76c1facbb84ea573f7e29908dfa1d7bc5cb7b` (два commit от базы: scaffolding + L00 bookkeeping);
- `npm ci` — exit 0, но Node `24.18.0` дал environment-only `EBADENGINE`; требуется `>=24.19.0 <25`;
- `npm run typecheck` — exit 0;
- `node --test apps/studio/test/b10-full-author-assistant-cycle.test.mjs` — exit 0, 1/1 pass;
- browser, HTTP adapter, live provider и Player launch пока не доказаны.

## L01 — local HTTP boundaries (2026-09-09)

- shared loopback Host/port + Origin + fetch-metadata policy now guards settings, Studio proxy and direct local Control;
- proxy and Control request bodies are bounded before mutation/upstream forwarding;
- unknown settings fields, forbidden provider targets and unsupported methods fail closed;
- `npm run typecheck` — exit 0;
- `node --test apps/studio/test/live-author-boundary.test.mjs` — exit 0, 1/1;
- `node --test apps/studio/test/proxy-auth.test.mjs apps/server/test/control-http.test.mjs` — exit 0, 7/7;
- no upstream call and no draft mutation on rejected requests;
- Node `24.18.0` vs required `>=24.19.0 <25` remains an environment limitation.

## L02 — ModelProvider → AgentBackend (2026-09-09)

- server-owned bridge now calls the existing OpenAI-compatible adapter with bounded JSON request data;
- deadline, per-turn cancel, close, disconnect/rotation, busy and eight-session limit are explicit;
- provider 401/403/429/timeout/abort/invalid JSON/network outcomes map to AgentBackend codes;
- known provider usage and request IDs survive structured failures; no secret or gameplay authority is exposed;
- `npm run typecheck` — exit 0;
- `npm run test:ai` — exit 0, 46/46;
- no paid API call; fetch-only stubs exercised the real HTTP adapter.

Следующее: L03 — provider settings lifecycle, safe process-memory credential handling and user-visible statuses.

## L03 — provider settings lifecycle (2026-09-09)

- explicit Studio provider state machine: `not_configured → settings_saved → requesting → connected | error`; rotation/disconnect invalidate outstanding sessions;
- `connectionCheck` reflects the real lifecycle outcome; the always-`not_performed` stub is gone;
- status errors use AgentBackend semantics (`auth_required`/`rate_limited`/`timeout`/`invalid_response`/`backend_error`/`network`); raw provider enums are not exposed;
- UI renders all five states with targeted hints; password field cleared on submit/disconnect; key stays process-memory only and is never echoed; `remainingTokens` stays `null` («неизвестен»);
- no-key/rejected-key assistant failures explain where to connect the AI (`backend.auth_required` hint in the assistant progress panel);
- failed settings updates keep the working configuration; no provider call while saving settings;
- `npm run typecheck` — exit 0;
- `node --test apps/studio/test/live-author-provider-lifecycle.test.mjs` — exit 0, 1/1 (new lifecycle test);
- boundary + UI tests — exit 0, 7/7; `packages/ai` + `packages/control` — exit 0, 143/143;
- `apps/studio` group 55/59: 4 failures reproduce without L03 changes (pre-existing B05/B10-era scripted-backend expectations on this branch);
- no paid API call; Node `24.18.0` vs `>=24.19.0 <25` remains an environment limitation.

Следующее: L04 — контекст и формат ответа (canonical schema, полный small-quest контекст, свежий revision после Apply).

Release: `v0.1.0`  
B12 merge: `3e6fcfd9c42910561500aca8c73e639d9bcf2f9b`  
Published `main` CI: #729 / `34251551857` — success

## B12 завершён

- B12.1 companion production external smoke: deploy run `34239102418`, Cloudflare version `cd0d8948-86d3-4a56-9b5f-c97bbec79771`;
- B12.2 SQLite online backup/restore + 12/12 Florence assets + restart recovery;
- B12.3 dependency audit 0/0 + provider 429 no-turn save integrity;
- B12.4 real OpenRouter provider eval: run `34250711595`, model `deepseek/deepseek-v4-flash-0731`, structural contract 12/12, semantic 5/12, 16 attempts, mean latency 12,176 ms, max 25,002 ms; aggregate token usage `null` because telemetry was incomplete;
- B12.5 real Chromium T29 mobile/focus/keyboard smoke: run `34246143800` PASS;
- B12.6 permanent release rollback drill: r1→r2→rollback r1 + restart/session pinning;
- B12.7 persistent Node+SQLite `npm start`, real health/control probes and graceful SIGTERM;
- T01–33/T36–37 matrix consolidated;
- README/runbook/changelog are release-facing;
- final cleaned PR head `abf23383e2e70b80aa6c029da17c6e5ab0a66361`, CI #728 / `34251382755` — success;
- PR #36 merged as `3e6fcfd9c42910561500aca8c73e639d9bcf2f9b`;
- `main` CI #729 / `34251551857` — success;
- tag `v0.1.0` verified at the exact merge SHA;
- temporary tag branch removed by run `34251870134`.

## Live-provider interpretation

The real compatible-provider/contract boundary is accepted, but the selected model is not qualified as the recommended intent-understanding model: semantic score was 5/12 (41.7%) despite 12/12 contract safety. All four narrative cases passed. Provider usage telemetry was incomplete, so total tokens remain `null` rather than guessed.

The API key existed only as a GitHub Actions Secret. The one-shot live-eval workflow was removed after evidence capture and is absent from `main`.

## Codex status

Deterministic adapter/account/controller evidence is green: exact protocol pin, account isolation, quota semantics, logout/rotation, browser/device-code flow and no automatic paid fallback. No authenticated live subscription App Server session is claimed in `v0.1.0`.

## Последующий блок — B13, после L00–L09

B13 допускается после принятого B12, но текущий приоритет пользователя — завершение сквозного авторского маршрута L00–L09. Builder/deployment остаётся отдельным блоком; опубликованные доказательства `v0.1.0` сохраняются.

The first bounded slice should follow the canonical specification rather than expand scope ad hoc: establish the exact B13 baseline and implement the smallest repo/workspace boundary before any production deployment authority.

Operational procedure: `docs/RUNBOOK.md`. Acceptance truth: `docs/B12-ACCEPTANCE-MATRIX.md`. Evidence ledger: `docs/RELEASE-REPORT.md`.
