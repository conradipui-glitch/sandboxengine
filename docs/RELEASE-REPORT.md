# Living History Engine — Release Report

Status: **B12 in progress — B12.1 and B12.2 accepted**  
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
| clean checkout + `npm ci` | **PASS** | Engine PR #36 CI #686 / run `34241997225` |
| full `npm run verify` | **PASS on B12.2 implementation head** | head `8113d7129544ad58aa0c628489d2415de78bf6d9`; CI #686 / `34241997225` |
| external deployed-address smoke | **PASS** | production #50 / `34239102418`; all probes passed after deploy |
| backup/restore incl. assets | **PASS — B12.2** | CI #686 release drill; SQLite backup + clean restore + 12 asset hashes |
| restart / operation recovery | **PASS — local SQLite Runtime** | existing T10/T12 durable restart suite + restored replay in B12.2 drill |
| dependency vulnerability triage | **OPEN BLOCKER / B12.3** | `npm ci` currently reports 1 moderate + 1 high; exact advisory/runtime relevance must be identified |
| quota/error behavior | **PENDING B12.3** | prove limits/errors do not corrupt saves |
| logs / secret-boundary review | **PENDING B12.3** | inspect release logs/public errors; secrets must not appear |
| bounded provider live eval | **PENDING** | explicit provider/model/budget; fake tests are not live evidence |
| token / attempt / latency report | **PENDING** | record measured scenario results; unknown values remain unknown |
| T01–33 / T36–37 matrix | **PENDING CONSOLIDATION** | map existing evidence, rerun only missing/release-sensitive checks |
| Codex live status | **PENDING RELEASE STATEMENT** | state verified/unavailable/limited exactly; no API/subscription conflation |
| README / runbook / changelog | **PENDING B12 AUDIT** | update only against actual RC behavior |
| final docs gate | **PENDING FINAL RC** | `npm run docs:check` is green now; renew on final RC |
| rollback procedure | **PENDING DRILL** | must identify tested release/session behavior, not prose-only rollback |
| release tag / commit | **NOT CREATED** | only after all release blockers are closed |

## 3. B12.1 — external production smoke — ACCEPTED

Companion `conradipui-glitch/sandbox` PR #11 added a bounded read-only smoke immediately after `wrangler deploy --keep-vars`.

Accepted production evidence:

- merge: `a6d5db944960ab7c8672349e329e6ff9ba4ff649`;
- production workflow: #50 / run `34239102418` — **success**;
- deployed version: `cd0d8948-86d3-4a56-9b5f-c97bbec79771`;
- `GET /api/health` — **PASS**, attempt 1;
- `GET /api/scenarios` — **PASS**, attempt 1;
- `GET /` — **PASS**, attempt 1;
- smoke ran only after Wrangler reported successful deployment;
- probe is read-only and creates no game session or synthetic product-analytics event.

## 4. B12.2 — backup/restore + restart/recovery — ACCEPTED FOR LOCAL ENGINE STORAGE

The release branch adds `npm run drill:backup-restore`, and root `npm run verify` now requires it. The drill uses Node 24's SQLite backup API rather than copying only the main database file while WAL mode may be active.

Exact evidence:

- implementation head: `8113d7129544ad58aa0c628489d2415de78bf6d9`;
- PR #36 CI #686 / run `34241997225` — **success**;
- SQLite online backup transferred **11 pages**;
- restored session: `session-1`;
- restored revision: **1**;
- restored pinned release: `release-1`;
- restored content hash: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
- restored turn count: **1**;
- retry of the committed operation after restore: **idempotent replay = true**;
- Florence asset manifest: `living-history.asset-migration/1`;
- restored assets: **12/12**;
- every restored asset was rechecked against the pinned SHA-256 manifest;
- pinned Florence source commit remained `092bcef0be5943e32bf02f08f9e9d4cde393fa95`.

The same exact CI also reran the existing durable recovery suite:

- lost response after commit replays identically after adapter restart;
- crash before commit leaves revision/turn unchanged;
- expired lease is reacquired with a higher fencing token;
- stale worker commit is rejected;
- final committed operation replays after another restart;
- SQLite busy timeout fails without publishing partial operation state.

**Scope limitation:** this is evidence for the standalone Engine's local SQLite Runtime and repository Florence assets. It is deliberately **not** claimed as a Cloudflare Durable Object backup/restore test.

## 5. B12.3 — release security / quota / log gate — NEXT

A new release blocker surfaced in exact CI: `npm ci` reported **2 vulnerabilities: 1 moderate, 1 high**. B12 must identify the exact dependency/advisory and whether it is runtime-reachable or dev-only before choosing upgrade, mitigation or documented non-runtime exception.

B12.3 also consolidates existing quota/error/secret-boundary tests into release evidence and adds only the missing release-sensitive checks. A high-severity advisory is not ignored merely because the functional test suite is green.

## 6. Known release constraints

- B13 Builder/deployment orchestration is not part of B12 release acceptance and must not be presented as shipped.
- Florence Engine production rollout is a separate operational decision; publication of the BFF does not imply the route is enabled.
- Live provider/Codex statements remain pending until their dedicated bounded checks are run with actual available credentials/accounts and explicit budget.
- The production smoke proves public reachability and API/client shell health; it does not prove Engine routing is enabled, nor does it mutate production state.

## 7. Remaining release blockers

1. dependency vulnerability triage + quota/error/log/secret-boundary release gate;
2. bounded provider evaluation and release telemetry summary;
3. evidence consolidation for T01–33/T36–37;
4. release docs/runbook/changelog and tested rollback procedure;
5. final exact-head CI, concrete RC commit and release tag.

No release tag should be created while any blocker above remains unresolved.
