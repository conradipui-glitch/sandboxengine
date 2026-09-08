# Living History Engine — Release Report

Status: **B12 in progress — B12.1 external deployment smoke accepted**  
Report started: 2026-09-08  
Release baseline: `sandboxengine@5b438214f1d709dd43244f107f883f6b2fc5f6ac`

This report is the evidence ledger for B12. A green build or a successful deployment alone does not close B12. Unknown, unavailable and not-yet-run checks remain explicit rather than being converted to pass.

## 1. Published B11 baseline

### Engine

| Evidence | Result |
|---|---|
| B11 PR #35 final head | `8d8d899e14a8d2ff56e9aac0e6ba94695738c194` |
| PR CI #681 / run `34237564459` | **PASS** — full root verify |
| B11 merge | `5b438214f1d709dd43244f107f883f6b2fc5f6ac` |
| published `main` CI #682 / run `34237754065` | **PASS** — full root verify |

### Sandbox production integration

| Evidence | Result |
|---|---|
| B11 integration merge | `3d9cc885592ec229d2083883ea38d83de9fcc199` |
| production deploy #49 / run `34238155592` | **PASS** — install, 49 tests, build, Wrangler deploy |
| B11 Cloudflare version | `573525a6-4ff5-43d9-9642-62504eabb289` |
| B12.1 smoke PR #11 head | `401043e2a815e9ff4991bbaccb00c9c84b3bb399` |
| PR Verify #6 / run `34238768580` | **PASS** — install, tests, build, smoke-probe syntax |
| B12.1 merge | `a6d5db944960ab7c8672349e329e6ff9ba4ff649` |
| production deploy #50 / run `34239102418` | **PASS** — install, 49 tests, build, Wrangler deploy, external smoke |
| current Cloudflare version | `cd0d8948-86d3-4a56-9b5f-c97bbec79771` |
| Worker startup in deploy log | 6 ms |
| deployed DO bindings | `HistorySession`, `ProductAnalytics`, `RuntimeRouteSession` |

Production rollout note: publication does not itself enable Florence Engine assignment. Missing/unexpected `ENGINE_FLORENCE_ROLLOUT` normalizes to `off`; existing legacy sessions are not converted.

## 2. B12 release gates

| Gate | Status | Evidence / next action |
|---|---|---|
| clean checkout + `npm ci` | **PASS (current B12 evidence)** | Engine PR #36 CI #683 / run `34239045563`; sandbox production #50 also installed from lockfile |
| full `npm run verify` | **PASS on current Engine B12 head before this report update** | PR #36 CI #683 / `34239045563`; renew exact-head evidence after report/drill changes |
| build from release candidate | **PARTIAL** | production sandbox build proven; final Engine RC commit not selected yet |
| external deployed-address smoke | **PASS** | production #50 / `34239102418`; all probes passed after deploy |
| backup/restore incl. assets | **PENDING — B12.2** | next bounded slice |
| restart / operation recovery | **PENDING — B12.2** | next bounded slice |
| quota/error behavior | **PENDING** | prove limits fail without corrupting saves |
| logs / secret-boundary review | **PENDING** | inspect release logs and public errors; secrets must not appear |
| bounded provider live eval | **PENDING** | explicit provider/model/budget; fake tests are not live evidence |
| token / attempt / latency report | **PENDING** | record measured scenario results; unknown values remain unknown |
| T01–33 / T36–37 matrix | **PENDING CONSOLIDATION** | map existing evidence, rerun only missing/release-sensitive checks |
| Codex live status | **PENDING RELEASE STATEMENT** | state verified/unavailable/limited exactly; no API/subscription conflation |
| README / runbook / changelog | **PENDING B12 AUDIT** | update only against actual RC behavior |
| final docs gate | **PENDING FINAL RC** | `npm run docs:check` as part of exact RC verify |
| rollback procedure | **PENDING DRILL** | must identify tested release/session behavior, not prose-only rollback |
| release tag / commit | **NOT CREATED** | only after all release blockers are closed |

## 3. B12.1 — external production smoke — ACCEPTED

Companion `conradipui-glitch/sandbox` PR #11 added a bounded read-only smoke immediately after `wrangler deploy --keep-vars`.

Accepted production evidence:

- merge: `a6d5db944960ab7c8672349e329e6ff9ba4ff649`;
- production workflow: #50 / run `34239102418` — **success**;
- deployed version: `cd0d8948-86d3-4a56-9b5f-c97bbec79771`;
- `GET /api/health` — **PASS**, attempt 1;
- `GET /api/scenarios` — **PASS**, attempt 1; payload includes Florence and legacy Russia scenario;
- `GET /` — **PASS**, attempt 1; deployed application shell validated;
- smoke completed only after Wrangler reported successful deployment;
- probe is read-only and creates no game session or synthetic product-analytics event.

This closes the release-evidence gap from B11, where Wrangler deployment was proven but no post-deploy HTTP request was part of the workflow.

## 4. B12.2 — backup/restore and restart/recovery drill

**Next bounded slice.** Required evidence must prove behavior, not merely the presence of backup code or storage tests.

Target acceptance:

1. create or use a deterministic persisted session/release fixture;
2. export/backup the authoritative storage plus referenced asset identities;
3. restore into a clean storage instance;
4. prove restored `PlayerView`, revision, release identity and asset references match the pre-backup state;
5. simulate process/storage-adapter restart and recover the same session;
6. replay the same operation key and prove no duplicate mutation/charge;
7. record exact commands/tests and failure boundaries in this report.

The drill must not claim Cloudflare Durable Object backup semantics unless they are actually exercised. A local SQLite/storage drill is valid Engine release evidence when clearly labeled as such; production-platform recovery evidence remains separately identified.

## 5. Known release constraints

- B13 Builder/deployment orchestration is not part of B12 release acceptance and must not be presented as shipped.
- Florence Engine production rollout is a separate operational decision; publication of the BFF does not imply the route is enabled.
- Live provider/Codex statements remain pending until their dedicated bounded checks are run with actual available credentials/accounts and explicit budget.
- The production smoke proves public reachability and API/client shell health; it does not prove Engine routing is enabled, nor does it mutate production state.

## 6. Remaining release blockers

1. backup/restore + restart/recovery drill;
2. quota/error and log/secret-boundary checks;
3. bounded provider evaluation and release telemetry summary;
4. evidence consolidation for T01–33/T36–37;
5. release docs/runbook/changelog and tested rollback procedure;
6. final exact-head CI, concrete RC commit and release tag.

No release tag should be created while any blocker above remains unresolved.
