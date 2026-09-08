# Передача работы

Обновлено: 2026-09-08

Текущий блок: **B12 — release and operational handoff / final external gate**  
Ветка: `b12-release-hardening` / draft PR #36  
База: published B11 merge `5b438214f1d709dd43244f107f883f6b2fc5f6ac`

## Что уже закрыто

- B12.1 companion production external smoke: deploy run `34239102418`, Cloudflare version `cd0d8948-86d3-4a56-9b5f-c97bbec79771`;
- B12.2 SQLite online backup/restore + 12/12 Florence assets + restart recovery;
- B12.3 dependency audit 0/0 + provider 429 no-turn save integrity;
- B12.5 real Chromium T29 mobile/focus/keyboard smoke: run `34246143800` PASS; temporary workflow removed;
- B12.6 permanent release rollback drill: r1→r2→rollback r1 + restart/session pinning; CI #709 and renewed #713;
- B12.7 persistent Node+SQLite `npm start`, real health/control probes and graceful SIGTERM; head `847aa22f3e4457bccd5c4dc19ab6d27f26941afb`, CI #713 / `34246765104` success;
- T01–33/T36–37 matrix consolidated;
- README/runbook/changelog are now release-facing rather than bootstrap-era documentation.

## Exact live-provider status

One-shot read-only run `34243952551` called the real `npm run eval:ai` entrypoint. Environment values were absent:

- `LHE_EVAL_API_KEY`: not configured;
- `LHE_EVAL_MODEL`: not configured;
- result: `status: not_configured`;
- provider label: `https://openrouter.ai/api/v1`;
- model: `null`;
- live cases/tokens/latency: none.

This remains the only mandatory B12 external blocker. Do not substitute fake provider tests.

## Codex status

Deterministic adapter/account/controller evidence is green: exact protocol pin, account isolation, quota semantics, logout/rotation, browser/device-code flow and no automatic paid fallback. No authenticated live subscription App Server session is available/claimed.

## Next exact action when live provider credentials exist

1. intentionally configure `LHE_EVAL_API_KEY` and `LHE_EVAL_MODEL` for one bounded run;
2. run `npm run eval:ai` once with explicit budget/model;
3. record provider/model, case contract/semantic rates, attempts, tokens (or provider `null`) and latency in `docs/RELEASE-REPORT.md`;
4. remove any one-shot credential-bearing CI surface if one was needed;
5. run final exact-head `npm run verify`;
6. confirm docs gate and PR head;
7. only then create the B12 release commit/tag and merge/publish according to the project release procedure.

If credentials are still unavailable, leave B12 untagged and continue to state `not_configured`; do not begin B13 as a way to bypass this gate.

Operational procedure: `docs/RUNBOOK.md`. Acceptance truth: `docs/B12-ACCEPTANCE-MATRIX.md`.
