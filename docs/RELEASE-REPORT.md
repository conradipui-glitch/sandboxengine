# Living History Engine — B12 Release Report

Status: **B12 internal/operational gates green; live provider evidence still unavailable**  
Updated: 2026-09-08  
Release baseline: B11 merge `5b438214f1d709dd43244f107f883f6b2fc5f6ac`  
Release branch: `b12-release-hardening` / PR #36

This is the evidence ledger. A green build is not allowed to erase an unavailable external check.

## Accepted evidence

| Gate | Result | Exact evidence |
|---|---|---|
| B11 published baseline | **PASS** | B11 merge `5b438214...`; main CI #682 / `34237754065` |
| external production smoke | **PASS** | companion `sandbox` merge `a6d5db94...`; deploy #50 / `34239102418`; Cloudflare version `cd0d8948-86d3-4a56-9b5f-c97bbec79771`; `/api/health`, `/api/scenarios`, `/` pass attempt 1 |
| dependency audit | **PASS** | B12.3 CI #698 / `34243238408`: `npm ci` 0 vulnerabilities; full/production audit 0 |
| backup/restore | **PASS / SCOPED** | drill in root verify: 11 pages, revision 1, pinned `release-1`, one turn, idempotent replay, 12/12 Florence hashes |
| restart/recovery | **PASS** | T10/T12 durable suite + backup restore replay |
| quota/rate-limit save integrity | **PASS** | two retryable provider HTTP 429 failures → replayable no-turn; save unchanged; prepared authored action still commits |
| release rollback | **PASS** | CI #709 / `34245705625`, rerun in #713: r1→r2→rollback r1 + restart; active session pinning preserved |
| T29 mobile/browser | **PASS** | one-shot Chromium `34246143800`: 360×800, focus/keyboard/onboarding/replay and no blocking overflow/error |
| persistent start/stop | **PASS** | head `847aa22f3e4457bccd5c4dc19ab6d27f26941afb`, CI #713 / `34246765104`: `/healthz` 200, Control read 200, SQLite created, SIGTERM exit 0 |
| full regression before docs sync | **PASS** | CI #713 / `34246765104`; audit + all tests + three release drills + boundaries + docs |
| T01–33/T36–37 consolidation | **DONE** | `docs/B12-ACCEPTANCE-MATRIX.md` |

## B12.1 — production smoke

The companion Worker deploy is reachable after real deployment and the smoke is read-only. It creates no synthetic game session/analytics event. Publication does not enable `ENGINE_FLORENCE_ROLLOUT`; existing legacy sessions are not converted.

## B12.2 — backup/restore and restart

`npm run drill:backup-restore` is permanent root-verify evidence. It uses SQLite online backup rather than a raw live WAL-file copy. Scope is standalone Engine SQLite plus repository Florence assets, **not Cloudflare Durable Objects**.

## B12.3 — security/quota/public error boundary

The initial build-only advisories were remediated by `ajv@8.20.0` and `fast-uri@3.1.7`. The temporary contents-write lock refresh workflow was deleted. Permanent `npm run audit:release` blocks moderate/high/critical findings in the full graph.

Existing exact tests preserve quota zero vs null/stale semantics, inference vs management credential separation, sanitized provider errors, secret-free exports/task packages/playtest views and project/session isolation.

## B12.4 — live provider evaluation — UNAVAILABLE, NOT PASS

A one-shot read-only CI probe ran `npm run eval:ai` in run `34243952551` with the documented release environment names. Result:

```json
{"status":"not_configured","provider":"https://openrouter.ai/api/v1","model":null,"cases":[]}
```

Neither `LHE_EVAL_API_KEY` nor `LHE_EVAL_MODEL` was configured. Therefore no real-model semantic rate, attempts, tokens or latency exists. Deterministic provider tests are not substituted for live evidence.

The evaluator is already bounded and, once configured, records per-case contract/semantic result, latency, attempts, provider-reported tokens, model ID and request IDs.

## B12.5 — mobile/keyboard Studio release smoke — ACCEPTED

Final one-shot Chromium evidence: run `34246143800`.

Machine result:

```json
{"result":"pass","viewport":"360x800","horizontalOverflow":false,"onboarding":["auto-start","skip","help","escape-focus-return","replay","next","back","skip"],"editableControl":"project-title","keyboardInputPreserved":true,"pageErrors":0,"unexpectedHttpFailures":0,"canonicalLocalAuthProbe404":true,"favicon404Observed":false}
```

The exact 404 for `/control/v1/auth/session` is a tested local Studio protocol signal selecting local-owner mode, not an unknown failed resource. Temporary Playwright workflow/dependency installation was removed after evidence capture and is not part of the release lockfile.

## B12.6 — durable release rollback — ACCEPTED

Permanent `npm run drill:rollback` is in root verify. It proves:

- immutable release r1 then r2 publication;
- session A remains pinned to r1;
- session B created after r2 remains pinned to r2;
- rollback moves the current pointer r2→r1 only for future sessions;
- full store/runtime reopen preserves pointer and bindings;
- session C after rollback gets r1;
- immutable hashes and publication history are unchanged.

First accepted CI #709 / `34245705625`; renewed in CI #713.

## B12.7 — persistent startup/shutdown — ACCEPTED

`npm start` now names the compiled Node+SQLite Runtime+Control entrypoint. Permanent `npm run drill:startup-shutdown` starts it on ephemeral loopback ports and validates actual bound-port reporting, Runtime `/healthz`, a safe Control read, SQLite file creation and SIGTERM clean exit.

Exact implementation head `847aa22f3e4457bccd5c4dc19ab6d27f26941afb`; CI #713 / `34246765104` — success.

## Codex release statement

Codex adapter/account/controller deterministic tests cover protocol pinning, account isolation, browser/device-code modes, quota null/zero, logout/credential rotation and explicit no paid-API fallback. An authenticated live Codex subscription App Server run is **not available and not claimed**.

## Current release limitations

- live provider eval is `not_configured` and remains the mandatory B12 external blocker;
- persistent `npm start` does not automatically compose a live provider;
- built-in log rotation is not shipped; supervisor/platform owns stdout/stderr retention;
- no Cloudflare DO backup claim;
- no shared-network SQLite multi-writer claim;
- Florence Engine production rollout is an explicit companion-app operation;
- B13 Builder/code/GitHub/deployment orchestration is not shipped.

## Remaining blocker and finalization

Only after a real `LHE_EVAL_API_KEY` + `LHE_EVAL_MODEL` is intentionally configured should B12 run one bounded live eval, record real model/provider + attempts/tokens/latency, then renew final exact-head root CI/docs gate and create the concrete release tag.

No B12 tag exists yet.
