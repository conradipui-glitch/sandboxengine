# Статус движка

Последнее обновление: 2026-09-08.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B11 published; B12 in progress** | B11 Engine merge `5b438214f1d709dd43244f107f883f6b2fc5f6ac`; published main CI #682 / `34237754065` success |
| Контракты/Core | **published through B11** | generic conditions/effects/authored cases; Core boundary tests reject quest-specific identities |
| Runtime storage/API | **B12.2 restore/restart evidence GREEN** | PR #36 head `8113d7129544ad58aa0c628489d2415de78bf6d9`; CI #686 / `34241997225` |
| Authoring / Control / Studio | **published through B10/B11 integration** | draft history/restore, release/publication, access controls, author assistant and playtest path |
| Presentation/assets/Player | **B12.2 asset restore GREEN** | all 12 Florence binaries survive backup→restore and re-match pinned SHA-256 manifest |
| Plugins | **B08 published** | trusted manifest/registry/execution + artifact-bound plugin evidence |
| Real quests | **B11 published** | Florence + Transfer Desk use shared Core without quest-ID branches; semantic acceptance proved |
| Sandbox production integration | **B12.1 external smoke GREEN** | merge `a6d5db944960ab7c8672349e329e6ff9ba4ff649`; production #50 / `34239102418`; Cloudflare version `cd0d8948-86d3-4a56-9b5f-c97bbec79771` |
| Release hardening | **B12.1 + B12.2 accepted; B12.3 active** | next: dependency vulnerability triage + quota/error/log/secret-boundary gate |
| Builder/deployment product | **B13 not started** | explicitly outside B12 release acceptance |

## B12.1 accepted — external production smoke

Production workflow #50 / run `34239102418` passed after merge `a6d5db944960ab7c8672349e329e6ff9ba4ff649`:

- install, 49 sandbox tests and build — PASS;
- Wrangler deploy — PASS;
- deployed Cloudflare version `cd0d8948-86d3-4a56-9b5f-c97bbec79771`;
- `/api/health` — PASS on attempt 1;
- `/api/scenarios` — PASS on attempt 1;
- `/` — PASS on attempt 1.

The smoke is read-only and does not create a game session or synthetic product analytics.

## B12.2 accepted — backup/restore + restart/recovery

Root `npm run verify` now includes `npm run drill:backup-restore`.

Exact evidence from PR #36 CI #686 / run `34241997225` on implementation head `8113d7129544ad58aa0c628489d2415de78bf6d9`:

- SQLite online backup: 11 pages;
- restored `session-1`: revision 1, pinned `release-1`, exact content hash;
- exactly one persisted turn after restore;
- retry of committed operation returns idempotent replay;
- 12/12 Florence assets restored with SHA-256 verification against `living-history.asset-migration/1`;
- existing T10/T12 durable recovery suite reran successfully: lost-response replay, crash-before-commit rollback, lease reacquire, fencing and busy-policy atomicity.

Scope is local standalone Engine SQLite + repository assets. No Cloudflare Durable Object backup claim is made.

## B12.3 active — release security / quota / logs

CI #686 exposed a new release blocker during `npm ci`: **2 known vulnerabilities (1 moderate, 1 high)**. Before any release candidate/tag, B12.3 must identify the exact advisory/dependency, determine runtime vs dev-only reachability, and either upgrade/mitigate or record a justified non-runtime exception with a reproducible audit gate.

The same slice consolidates quota/error and secret/log evidence already present in B06/B09 tests and adds only missing release-sensitive checks.

Canonical ledger: `docs/RELEASE-REPORT.md`.

Do not begin B13 while B12 release blockers remain open.
