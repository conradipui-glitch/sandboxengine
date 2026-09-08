# Living History Engine — B12 Release Report

Status: **B12 accepted and published as `v0.1.0`**  
Updated: 2026-09-08  
Release baseline: B11 merge `5b438214f1d709dd43244f107f883f6b2fc5f6ac`  
B12 merge: `3e6fcfd9c42910561500aca8c73e639d9bcf2f9b`  
Release tag: `v0.1.0` → `3e6fcfd9c42910561500aca8c73e639d9bcf2f9b`

This is the evidence ledger. A green build is not allowed to erase an unavailable or weak external check.

## Accepted evidence

| Gate | Result | Exact evidence |
|---|---|---|
| B11 published baseline | **PASS** | B11 merge `5b438214...`; main CI #682 / `34237754065` |
| external production smoke | **PASS** | companion `sandbox` merge `a6d5db94...`; deploy #50 / `34239102418`; Cloudflare version `cd0d8948-86d3-4a56-9b5f-c97bbec79771`; `/api/health`, `/api/scenarios`, `/` pass attempt 1 |
| dependency audit | **PASS** | B12.3 CI #698 / `34243238408`: `npm ci` 0 vulnerabilities; full/production audit 0 |
| backup/restore | **PASS / SCOPED** | drill in root verify: 11 pages, revision 1, pinned `release-1`, one turn, idempotent replay, 12/12 Florence hashes |
| restart/recovery | **PASS** | T10/T12 durable suite + backup restore replay |
| quota/rate-limit save integrity | **PASS** | two retryable provider HTTP 429 failures → replayable no-turn; save unchanged; prepared authored action still commits |
| release rollback | **PASS** | CI #709 / `34245705625`, rerun in later full verify: r1→r2→rollback r1 + restart; active session pinning preserved |
| T29 mobile/browser | **PASS** | one-shot Chromium `34246143800`: 360×800, focus/keyboard/onboarding/replay and no blocking overflow/error |
| persistent start/stop | **PASS** | head `847aa22f3e4457bccd5c4dc19ab6d27f26941afb`, CI #713 / `34246765104`: `/healthz` 200, Control read 200, SQLite created, SIGTERM exit 0 |
| live provider compatibility | **PASS / QUALITY LIMITATION** | OpenRouter run `34250711595`, model `deepseek/deepseek-v4-flash-0731`: contract 12/12; semantic 5/12; 16 attempts; mean 12,176 ms; max 25,002 ms |
| final cleaned PR head | **PASS** | head `abf23383e2e70b80aa6c029da17c6e5ab0a66361`; CI #728 / `34251382755` |
| published `main` | **PASS** | merge `3e6fcfd9c42910561500aca8c73e639d9bcf2f9b`; CI #729 / `34251551857` |
| release tag | **PASS** | tag workflow `34251761663`; verified `refs/tags/v0.1.0` points exactly to B12 merge; cleanup workflow `34251870134` removed temporary tag branch |
| T01–33/T36–37 consolidation | **DONE** | `docs/B12-ACCEPTANCE-MATRIX.md` |

## B12.1 — production smoke

The companion Worker deploy is reachable after real deployment and the smoke is read-only. It creates no synthetic game session/analytics event. Publication does not enable `ENGINE_FLORENCE_ROLLOUT`; existing legacy sessions are not converted.

## B12.2 — backup/restore and restart

`npm run drill:backup-restore` is permanent root-verify evidence. It uses SQLite online backup rather than a raw live WAL-file copy. Scope is standalone Engine SQLite plus repository Florence assets, **not Cloudflare Durable Objects**.

## B12.3 — security/quota/public error boundary

The initial build-only advisories were remediated by `ajv@8.20.0` and `fast-uri@3.1.7`. The temporary contents-write lock refresh workflow was deleted. Permanent `npm run audit:release` blocks moderate/high/critical findings in the full graph.

Existing exact tests preserve quota zero vs null/stale semantics, inference vs management credential separation, sanitized provider errors, secret-free exports/task packages/playtest views and project/session isolation.

## B12.4 — live provider evaluation — ACCEPTED WITH MODEL-QUALITY LIMITATION

The release gate ran the real `npm run eval:ai` entrypoint through OpenRouter in one bounded read-only workflow:

- run: `34250711595` — **success**;
- provider: `https://openrouter.ai/api/v1`;
- configured model: `deepseek/deepseek-v4-flash-0731`;
- cases: 12;
- structural contract: **12/12 = 100%**;
- semantic score: **5/12 = 41.7%**;
- total provider attempts: 16;
- mean per-case latency: **12,176 ms**;
- max per-case latency: **25,002 ms**;
- provider token telemetry: incomplete across cases, therefore aggregate total is **null**, not guessed.

The safe boundary passed every case: no case escaped the allowed result contract and prompt-injection handling passed. All four narrative cases passed semantic checks. Most intent-understanding fixtures did not meet their expected semantic outcome on this model, so this run **does not qualify `deepseek/deepseek-v4-flash-0731` as a recommended intent model**. The engine is provider/model configurable; model quality is an operational choice rather than authority to mutate Core state.

No mandatory semantic percentage is specified for the one-provider B12 live compatibility run. The release claim is therefore limited to: real provider connectivity, bounded execution, contract safety, telemetry capture and honest model-quality reporting. Deterministic tests remain the authority for engine invariants.

The one-shot secret-bearing workflow was removed immediately after evidence capture. The API key value was never written to repository content or logs.

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

## B12.7 — persistent startup/shutdown — ACCEPTED

`npm start` names the compiled Node+SQLite Runtime+Control entrypoint. Permanent `npm run drill:startup-shutdown` starts it on ephemeral loopback ports and validates actual bound-port reporting, Runtime `/healthz`, a safe Control read, SQLite file creation and SIGTERM clean exit.

## Codex release statement

Codex adapter/account/controller deterministic tests cover protocol pinning, account isolation, browser/device-code modes, quota null/zero, logout/credential rotation and explicit no paid-API fallback. An authenticated live Codex subscription App Server run is **not available and not claimed**. This is a documented limitation rather than a B12 API-provider blocker.

## Current release limitations

- `deepseek/deepseek-v4-flash-0731` passed structural compatibility but scored 41.7% on this small intent+narrative semantic corpus; do not present it as the recommended intent-understanding model from this evidence;
- provider token usage was not reported consistently, so aggregate live-eval token count remains `null`;
- persistent `npm start` does not automatically compose a live provider;
- built-in log rotation is not shipped; supervisor/platform owns stdout/stderr retention;
- no Cloudflare DO backup claim;
- no shared-network SQLite multi-writer claim;
- Florence Engine production rollout is an explicit companion-app operation;
- no authenticated live Codex subscription run is claimed;
- B13 Builder/code/GitHub/deployment orchestration is not shipped in `v0.1.0`.

## Publication result

B12 is complete and published:

- PR #36 merged as `3e6fcfd9c42910561500aca8c73e639d9bcf2f9b`;
- `main` CI #729 / `34251551857` passed on that exact merge;
- `v0.1.0` points exactly to that merge commit;
- temporary live/browser/write/tag workflow surfaces are absent from `main`;
- the temporary tag branch was removed after tag verification.

B13 may now start from accepted B12. B13 remains a separate acceptance block and must not retroactively change the `v0.1.0` evidence.
