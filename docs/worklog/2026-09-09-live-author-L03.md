# 2026-09-09 — L03 provider settings lifecycle in Studio

Branch: `feat/live-author-studio`
Baseline for this slice: `1bc76c1facbb84ea573f7e29908dfa1d7bc5cb7b` (L01+L02 implementation was committed as `24e12a8` before L03 work; L03 changes sit on top).

## Result

Completed the provider connection lifecycle for the local Studio:

- `LocalAuthorProvider` now keeps an explicit state machine: `not_configured → settings_saved → requesting → connected | error`; rotation (re-configure) and disconnect reset it and invalidate outstanding sessions via the L02 bridge;
- `connectionCheck` in `status()` reflects the real lifecycle outcome (`not_performed` / `connected` / `error`); the former always-`not_performed` value is gone;
- status-level error codes mirror the AgentBackend semantics (`auth_required`, `rate_limited`, `timeout`, `invalid_response`, `backend_error`, `network`); the raw provider enum (`http`) is never exposed to the UI;
- `provider-settings.ts` renders all five states from the server response, including targeted hints for auth/429/timeout errors; the password field is cleared on every submit/disconnect;
- no-key / rejected-key assistant failures are explained in the author assistant progress panel (`backend.auth_required` → where to connect the AI, `backend.rate_limited`, `backend.timeout` hints);
- credential remains process-memory only: never echoed by GET/POST/DELETE status responses, never persisted to draft/localStorage/logs; `remainingTokens` stays explicitly `null` ("неизвестен");
- failed settings updates (unknown fields, forbidden URL, oversized/invalid body) keep the previously working configuration; no provider call is made while saving settings;
- settings body limit (8 KiB) and method allowlist are enforced by the L01 boundary and covered here again.

## Verification

- `npm run typecheck` — exit 0;
- `node --test apps/studio/test/live-author-provider-lifecycle.test.mjs` — exit 0, 1/1 (new; covers configure → safe status → failed update keeps config → bad-key turn (401→`auth_required`, state `error`) → rotation with working key → successful turn (`requesting`→`connected`, usage/request-id preserved) → body limit 413 → method 405 → disconnect clears state and fails closed → fresh process requires the key again → no credential echo);
- `node --test apps/studio/test/live-author-provider-lifecycle.test.mjs apps/studio/test/live-author-boundary.test.mjs apps/studio/test/author-assistant-ui.test.mjs` — exit 0, 7/7;
- `node --test packages/ai/test/*.test.mjs packages/control/test/*.test.mjs` — exit 0, 143/143;
- `node --test apps/studio/test/*.test.mjs` — 55/59: the 4 failures (`author-assistant-app`, `b05-canonical-audit`, `playtest-bridge`, `static-entry`) reproduce on the tree without L03 changes (verified via `git stash`); they are pre-existing B05/B10-era scripted-backend expectations on this branch, not L03 regressions;
- no paid API call; the real HTTP path was exercised against a local stub only.

Node `24.18.0` vs required `>=24.19.0 <25` remains an environment limitation.

## Acceptance

L03 accepted on the lifecycle/regression evidence above: a new user can configure a provider in the browser without editing sources, sees distinct not-configured/saved/requesting/connected/error states, understands that the key lives until disconnect or server restart, and gets actionable error explanations. L08 (live acceptance with a real provider key) remains separately UNVERIFIED: no provider access.

Next card: L04 — assistant context and response format (canonical schema, full small-quest context, fresh revision after Apply).
