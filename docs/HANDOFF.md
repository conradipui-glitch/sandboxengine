# Передача работы

Обновлено: 2026-09-08

Текущий блок: **B12 — release and operational handoff / final publication**  
Ветка: `b12-release-hardening` / draft PR #36  
База: published B11 merge `5b438214f1d709dd43244f107f883f6b2fc5f6ac`

## Что уже закрыто

- B12.1 companion production external smoke: deploy run `34239102418`, Cloudflare version `cd0d8948-86d3-4a56-9b5f-c97bbec79771`;
- B12.2 SQLite online backup/restore + 12/12 Florence assets + restart recovery;
- B12.3 dependency audit 0/0 + provider 429 no-turn save integrity;
- B12.4 real OpenRouter provider eval: run `34250711595`, model `deepseek/deepseek-v4-flash-0731`, structural contract 12/12, semantic 5/12, 16 attempts, mean latency 12,176 ms, max 25,002 ms; aggregate token usage `null` because telemetry was incomplete;
- B12.5 real Chromium T29 mobile/focus/keyboard smoke: run `34246143800` PASS; temporary workflow removed;
- B12.6 permanent release rollback drill: r1→r2→rollback r1 + restart/session pinning; CI #709 and renewed #713;
- B12.7 persistent Node+SQLite `npm start`, real health/control probes and graceful SIGTERM; head `847aa22f3e4457bccd5c4dc19ab6d27f26941afb`, CI #713 / `34246765104` success;
- T01–33/T36–37 matrix consolidated;
- README/runbook/changelog are release-facing rather than bootstrap-era documentation.

## Exact live-provider result

The release used one bounded read-only OpenRouter run with the repository API key supplied only through GitHub Actions Secret.

- run: `34250711595` — success;
- provider: `https://openrouter.ai/api/v1`;
- model: `deepseek/deepseek-v4-flash-0731`;
- cases: 12;
- contract: 12/12 = 100%;
- semantic: 5/12 = 41.7%;
- attempts: 16;
- mean latency: 12,176 ms;
- max latency: 25,002 ms;
- total tokens: `null` because provider usage was not complete for every case.

Interpretation: the real compatible-provider/contract boundary is accepted, but this run does **not** qualify the chosen model as the recommended intent-understanding model. All four narrative cases and the injection case met semantic expectations; most intent fixtures did not. Model quality is therefore an explicit release limitation.

The temporary workflow that referenced `LHE_EVAL_API_KEY` was deleted after the run. The key value was not committed or printed.

## Codex status

Deterministic adapter/account/controller evidence is green: exact protocol pin, account isolation, quota semantics, logout/rotation, browser/device-code flow and no automatic paid fallback. No authenticated live subscription App Server session is available/claimed; this remains a documented B12 limitation, not an API-provider release blocker.

## Next exact action

1. obtain final exact-head CI on the cleaned B12 branch after this documentation sync;
2. confirm no one-shot live/browser/write workflow remains in the PR diff;
3. make PR #36 ready;
4. merge only the exact green head;
5. verify `main` CI for the merge commit;
6. create the B12 release tag on that verified merge commit;
7. update release status if the tag succeeds;
8. only then start B13.

Operational procedure: `docs/RUNBOOK.md`. Acceptance truth: `docs/B12-ACCEPTANCE-MATRIX.md`. Evidence ledger: `docs/RELEASE-REPORT.md`.
