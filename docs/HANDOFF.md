# Передача работы

Обновлено: 2026-09-08

Текущий блок: **B12 — выпуск и эксплуатационная передача / B12.1 release baseline + external smoke**  
База Engine: published B11 merge `5b438214f1d709dd43244f107f883f6b2fc5f6ac`  
Ветка Engine: `b12-release-hardening`  
Companion sandbox: `b12-post-deploy-smoke` / PR #11  
Статус: **in progress**

## Published baseline

### Engine

- B11 PR #35 final head `8d8d899e14a8d2ff56e9aac0e6ba94695738c194`;
- exact-head CI #681 / `34237564459` — success;
- merge `5b438214f1d709dd43244f107f883f6b2fc5f6ac`;
- published main CI #682 / `34237754065` — success.

### Sandbox production

- B11 PR #10 verified head `5480c77a59912f435c3f9d1bafc2985c23fbe531`;
- Verify #5 / `34236822232` — success;
- merge `3d9cc885592ec229d2083883ea38d83de9fcc199`;
- production deploy #49 / `34238155592` — install, 49 tests, build and Wrangler deploy success;
- deployed Worker `living-history-sandbox`;
- Cloudflare version `573525a6-4ff5-43d9-9642-62504eabb289`;
- deploy log confirms `HistorySession`, `ProductAnalytics`, `RuntimeRouteSession` bindings.

B11 is therefore fully published. Rollout remains safe-by-default: absent/unexpected `ENGINE_FLORENCE_ROLLOUT` is `off`; existing legacy sessions are not migrated.

## B12 contract

Per `docs/SPECIFICATION.md`, B12 is release/operational handoff, not a new feature block. It requires:

- clean install/build/full regression;
- bounded provider live eval;
- backup/restore including assets;
- restart/quota/log checks;
- measured token/attempt/latency evidence;
- acceptance matrix T01–33/T36–37 with honest live-Codex status;
- release candidate, README/runbook/changelog/release report;
- tested rollback;
- external smoke for any actual network deployment.

B13 Builder/deployment orchestration is explicitly not part of B12 acceptance.

## B12.1 implemented so far

### Engine evidence structure

- `docs/tasks/B12-01-release-baseline-smoke.md` freezes the exact B11 publication baseline and bounded slice;
- `docs/RELEASE-REPORT.md` is the durable release evidence ledger;
- `docs/STATUS.md` now marks B11 published and B12 in progress.

### Companion external smoke

`sandbox` PR #11 adds a post-Wrangler read-only smoke probe:

- `GET /api/health` → expected service identity;
- `GET /api/scenarios` → both Florence and legacy Russia present;
- `GET /` → deployed HTML app shell;
- 8 bounded attempts, 10 s request timeout, 2 s delay;
- no game session creation, no synthetic DAU/analytics;
- PR Verify syntax-checks the probe.

The real network smoke is deliberately **not** called PASS until PR #11 is merged and the resulting `main` deploy executes the new step successfully.

## Release report status

`docs/RELEASE-REPORT.md` currently records:

- published B11 Engine and sandbox evidence;
- production Cloudflare version;
- B12 gate table;
- external smoke design;
- explicit blockers;
- the execution-container DNS limitation as a limitation, not fake external evidence.

## Exact next action

1. require sandbox PR #11 exact-head Verify success;
2. merge PR #11 only on that verified head;
3. inspect the resulting production `main` workflow and require the new **Smoke deployed Worker** step to pass after Wrangler deploy;
4. record the exact run/version in `docs/RELEASE-REPORT.md` and close B12.1;
5. then start the backup/restore + restart drill as B12.2.

Do not activate Florence Engine rollout as part of B12.1. Do not begin B13.
