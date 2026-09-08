# Living History Engine — Release Report

Status: **B12 in progress — not yet an accepted release candidate**  
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
| B11 PR #10 verified head | `5480c77a59912f435c3f9d1bafc2985c23fbe531` |
| PR Verify #5 / run `34236822232` | **PASS** — tests + build |
| integration merge | `3d9cc885592ec229d2083883ea38d83de9fcc199` |
| production deploy #49 / run `34238155592` | **PASS** — install, tests, build, Wrangler deploy |
| Cloudflare Worker | `living-history-sandbox` |
| Cloudflare version | `573525a6-4ff5-43d9-9642-62504eabb289` |
| Worker startup in deploy log | 5 ms |
| deployed DO bindings | `HistorySession`, `ProductAnalytics`, `RuntimeRouteSession` |

Production rollout note: B11 publication does not itself enable Florence Engine assignment. Missing/unexpected `ENGINE_FLORENCE_ROLLOUT` normalizes to `off`; existing legacy sessions are not converted.

## 2. B12 release gates

| Gate | Status | Evidence / next action |
|---|---|---|
| clean checkout + `npm ci` | **PENDING B12 exact run** | run from B12 release branch/RC environment |
| full `npm run verify` | **PENDING B12 exact run** | B11 published main is green, but B12 requires RC evidence |
| build from release candidate | **PENDING** | record exact RC commit and build run |
| external deployed-address smoke | **IN PROGRESS** | companion `sandbox` B12 smoke PR; must pass after real main deployment |
| backup/restore incl. assets | **PENDING** | next bounded B12 slice |
| restart / operation recovery | **PENDING** | run documented drill, include state/revision evidence |
| quota/error behavior | **PENDING** | prove limits fail without corrupting saves |
| logs / secret-boundary review | **PENDING** | inspect release logs and public errors; secrets must not appear |
| bounded provider live eval | **PENDING** | explicit provider/model/budget; fake tests are not live evidence |
| token / attempt / latency report | **PENDING** | record measured scenario results; unknown values remain unknown |
| T01–33 / T36–37 matrix | **PENDING CONSOLIDATION** | map existing evidence, rerun only missing/release-sensitive checks |
| Codex live status | **PENDING RELEASE STATEMENT** | state verified/unavailable/limited exactly; no API/subscription conflation |
| README / runbook / changelog | **PENDING B12 AUDIT** | update only against actual RC behavior |
| final docs gate | **PENDING** | `npm run docs:check` as part of exact RC verify |
| rollback procedure | **PENDING DRILL** | must identify tested release/session behavior, not prose-only rollback |
| release tag / commit | **NOT CREATED** | only after all release blockers are closed |

## 3. External production smoke

B12.1 defines a read-only smoke for the already deployed sandbox address. It checks:

1. `/api/health` returns the expected healthy service identity;
2. `/api/scenarios` contains both Florence and the legacy Russia scenario;
3. `/` returns the expected deployed application shell.

The smoke uses bounded retries and request timeouts. It intentionally does not create a game session so production analytics are not polluted by deployment probes.

**Current status:** implementation is under companion review; no PASS is claimed until the smoke has run *after* a real main deployment.

## 4. Known release constraints

- B13 Builder/deployment orchestration is not part of B12 release acceptance and must not be presented as shipped.
- Florence Engine production rollout is a separate operational decision; publication of the BFF does not imply the route is enabled.
- External HTTP reachability could not be independently tested from the chat execution container because that environment could not resolve the `workers.dev` hostname. The Cloudflare deploy itself is proven by GitHub Actions logs; B12 adds the smoke inside the deployment environment to remove this dependency.
- Live provider/Codex statements remain pending until their dedicated bounded checks are run with actual available credentials/accounts and explicit budget.

## 5. Release blockers

Current blockers to an accepted B12 release candidate:

1. successful external smoke from the production deployment workflow;
2. clean B12 install/full verify/build on the exact RC candidate;
3. backup/restore + restart/recovery drill;
4. bounded provider evaluation and release telemetry summary;
5. evidence consolidation for the required acceptance matrix;
6. release docs/runbook/changelog and rollback drill;
7. final exact-head CI and release tag.

No release tag should be created while any blocker above remains unresolved.
