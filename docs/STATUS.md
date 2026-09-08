# Статус движка

Последнее обновление: 2026-09-08.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B11 published; B12 in progress** | B11 Engine merge `5b438214f1d709dd43244f107f883f6b2fc5f6ac`; published main CI #682 / `34237754065` success |
| Контракты/Core | **published through B11** | generic conditions/effects/authored cases; Core boundary tests reject quest-specific identities |
| Runtime storage/API | **published through B11** | release/session pinning, explicit authored options, free-text boundary, blocked/no-turn, idempotent replay |
| Authoring / Control / Studio | **published through B10/B11 integration** | draft history/restore, release/publication, access controls, author assistant and playtest path |
| Presentation/assets/Player | **published through B11** | safe `PlayerView + situation`, client-compatible BFF projection, verified Florence binaries |
| Plugins | **B08 published** | trusted manifest/registry/execution + artifact-bound plugin evidence |
| Real quests | **B11 published** | Florence + Transfer Desk use shared Core without quest-ID branches; semantic acceptance and asset hashes proved |
| Sandbox production integration | **B11 published** | `sandbox` merge `3d9cc885592ec229d2083883ea38d83de9fcc199`; production deploy #49 / `34238155592` success |
| Release hardening | **B12.1 in progress** | frozen release baseline + companion post-deploy read-only smoke; then restore/restart drill |
| Builder/deployment product | **B13 not started** | explicitly outside B12 release acceptance |

## Published B11 checkpoint

### Engine

- PR #35 final head: `8d8d899e14a8d2ff56e9aac0e6ba94695738c194`;
- PR CI #681 / run `34237564459`: **success**;
- merge: `5b438214f1d709dd43244f107f883f6b2fc5f6ac`;
- published `main` CI #682 / run `34237754065`: **success**.

### Sandbox / Cloudflare

- PR #10 verified head: `5480c77a59912f435c3f9d1bafc2985c23fbe531`;
- Verify #5 / run `34236822232`: **success**;
- merge: `3d9cc885592ec229d2083883ea38d83de9fcc199`;
- production deploy #49 / run `34238155592`: **success** (install, 49 tests, build, Wrangler deploy);
- deployed Worker: `living-history-sandbox`;
- Cloudflare version: `573525a6-4ff5-43d9-9642-62504eabb289`;
- deployed bindings include `HistorySession`, `ProductAnalytics`, `RuntimeRouteSession`.

B11 publication does not silently enable Engine routing. Missing/unexpected `ENGINE_FLORENCE_ROLLOUT` remains `off`, and existing legacy sessions are not converted.

## B12 — release and operational handoff

B12 follows `docs/SPECIFICATION.md`: clean install/build/full regression, bounded provider eval, backup/restore with assets, restart/quota/log checks, timing/token evidence, release documentation, rollback and external smoke of any deployed address.

The durable evidence ledger is `docs/RELEASE-REPORT.md`. Unknown or unrun checks remain explicitly pending.

### B12.1 current bounded slice

- release branch starts from exact published B11 Engine merge;
- companion `sandbox` branch starts from exact published B11 production merge;
- add a post-Wrangler **read-only** external smoke to the production workflow;
- smoke checks `/api/health`, `/api/scenarios` and the deployed application shell with bounded retries/timeouts;
- no test session is created and production analytics are not polluted;
- record the real post-deploy smoke run in `docs/RELEASE-REPORT.md` before closing B12.1.

## Next gates after B12.1

1. backup/restore + restart/recovery drill from a clean checkout;
2. quota/error/log boundary checks;
3. bounded live provider evaluation with explicit model/budget and honest Codex status;
4. consolidate T01–33/T36–37 evidence and re-run release-sensitive gaps;
5. README/runbook/changelog/final docs gate;
6. exact release-candidate verify, rollback drill, then release tag.

Do not begin B13 while B12 release blockers remain open.
