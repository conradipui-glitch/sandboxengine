# Living History Engine — Release Report

Status: **B12 in progress — B12.1, B12.2 and B12.3 accepted**  
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
| deployed DO bindings | `HistorySession`, `ProductAnalytics`, `RuntimeRouteSession` |

Production rollout note: publication does not itself enable Florence Engine assignment. Missing/unexpected `ENGINE_FLORENCE_ROLLOUT` normalizes to `off`; existing legacy sessions are not converted.

## 2. B12 release gates

| Gate | Status | Evidence / next action |
|---|---|---|
| clean checkout + `npm ci` | **PASS** | PR #36 CI #698 / run `34243238408`; 0 known vulnerabilities after install |
| full `npm run verify` | **PASS on B12.3 implementation head** | head `6f5588b2d88870f89a002b6db84867e1b6a3bc41`; CI #698 / `34243238408` |
| external deployed-address smoke | **PASS — B12.1** | production #50 / `34239102418`; all probes passed after deploy |
| backup/restore incl. assets | **PASS — B12.2** | SQLite backup + clean restore + 12/12 asset hashes |
| restart / operation recovery | **PASS — B12.2 local SQLite Runtime** | durable T10/T12 suite + restored replay |
| dependency vulnerability gate | **PASS — B12.3** | full and production dependency graphs both 0 known vulnerabilities; permanent audit gate in root verify |
| quota/error save integrity | **PASS — B12.3 within implemented scope** | provider HTTP 429 exhaustion is bounded, replayable no-turn, save remains unchanged; prepared authored action still works |
| quota telemetry semantics | **PASS — B12.3 deterministic evidence** | zero/null/stale/credential-revision and management-vs-inference separation remain explicit |
| secret/public-error boundary | **PASS — B12.3 deterministic release evidence** | provider bodies/credentials are absent from normalized errors/safe views; exports/task packages/trace paths retain secret-free checks |
| bounded provider live eval | **PENDING — B12.4** | explicit live credentials + model required; otherwise release statement must say `not_configured`/unavailable |
| token / attempt / latency report | **PENDING — B12.4** | `eval:ai` already emits per-case usage, attempts and latency when live configured |
| T01–33 / T36–37 matrix | **PENDING CONSOLIDATION** | map exact existing evidence and identify only real gaps |
| Codex live status | **PENDING RELEASE STATEMENT** | deterministic protocol evidence exists; live subscription evidence only if an actual account is available |
| README / runbook / changelog | **PENDING B12 AUDIT** | update against actual RC behavior |
| final docs gate | **PENDING FINAL RC** | docs gate is green now; renew on final RC |
| rollback procedure | **PENDING DRILL** | prove release/session rollback, not prose only |
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

Root `npm run verify` includes `npm run drill:backup-restore`. The drill uses Node 24's SQLite online backup API instead of copying only the main database file while WAL mode may be active.

Exact evidence first accepted on implementation head `8113d7129544ad58aa0c628489d2415de78bf6d9`, CI #686 / `34241997225`, and rerun successfully by later B12 exact-head CI:

- SQLite online backup transferred **11 pages**;
- restored `session-1` at revision **1**;
- pinned `release-1` and exact content hash preserved;
- exactly one turn preserved;
- retry of committed operation returns idempotent replay;
- Florence asset manifest `living-history.asset-migration/1` preserved;
- **12/12** assets restored and SHA-256 checked;
- pinned source commit remains `092bcef0be5943e32bf02f08f9e9d4cde393fa95`.

The durable recovery suite also proves lost-response replay, crash-before-commit rollback, lease reacquire, stale fencing rejection and bounded SQLite busy failure without partial publication.

**Scope limitation:** standalone Engine local SQLite Runtime + repository Florence assets. This is deliberately not claimed as a Cloudflare Durable Object backup/restore test.

## 5. B12.3 — release security / quota / log gate — ACCEPTED

Exact accepted implementation head: `6f5588b2d88870f89a002b6db84867e1b6a3bc41`.  
PR #36 CI #698 / run `34243238408` — **success**.

### Dependency remediation and permanent gate

Earlier B12 install evidence exposed one moderate and one high advisory in the dev/build graph:

- direct dev dependency `ajv@8.17.1` had the `$data` ReDoS advisory affecting versions below the fixed range;
- transitive `fast-uri@3.1.0` carried the high-severity findings;
- the production dependency graph was already clean.

B12 upgraded the build graph to:

- `ajv@8.20.0`;
- `fast-uri@3.1.7` through a refreshed lockfile.

A one-shot contents-write lock-refresh workflow was used only on the B12 branch, then deleted before the accepted head. It does not ship in the PR.

The permanent `npm run audit:release` gate is now part of root `npm run verify`. Exact CI #698 proves:

- `npm ci` — **found 0 vulnerabilities**;
- all dependencies — info 0, low 0, moderate 0, high 0, critical 0;
- production dependencies — info 0, low 0, moderate 0, high 0, critical 0;
- moderate/high/critical findings anywhere now fail the release audit.

### Provider quota/rate-limit save integrity

`apps/server/test/b12-runtime-quota-integrity.test.mjs` adds the missing release-sensitive cross-layer proof:

- the intent provider returns two retryable HTTP 429 responses;
- retry count remains bounded to the existing interpreter policy;
- Runtime returns `INTENT_FAILED` as a no-turn result;
- world revision stays 0, elapsed time/resources/state stay unchanged and no turn is persisted;
- retry of the same idempotency key replays the same no-turn result without another provider call;
- an explicit prepared authored option remains available afterwards and commits normally.

This proves save integrity for upstream provider quota/rate-limit failure. It does **not** claim a separate local project billing-quota subsystem that the Engine does not implement.

### Existing quota and secret-boundary evidence consolidated by the same exact CI

The exact B12.3 run also reruns and passes deterministic checks that:

- real numeric zero is preserved and unknown quota values remain `null`;
- stale quota is explicit and cache identity includes credential revision;
- OpenRouter inference-key quota and account-management credential remain separate;
- quota endpoint failure does not fabricate an inference failure or fake balance;
- Codex account/quota state is isolated per controller/account and logout/credential rotation invalidates cached state/session handles;
- provider credentials never enter configured URLs or safe connection views;
- normalized HTTP provider errors omit raw provider bodies and credentials;
- `eval:ai` in unconfigured mode does not echo unrelated environment secrets;
- draft/release exports are structurally secret-free;
- secret-shaped imported/task-package material is rejected;
- playtest evidence and public Player views remain deny-by-default and project/session scoped.

`check:boundaries` and `docs:check` also passed in the same exact run.

## 6. B12.4 — bounded live provider eval + telemetry — NEXT

The existing `npm run eval:ai` is already explicitly opt-in and requires:

- `LHE_EVAL_API_KEY`;
- `LHE_EVAL_MODEL`;
- optional `LHE_EVAL_BASE_URL` (defaults to OpenRouter compatible API);
- optional `LHE_EVAL_OUTPUT`.

When configured, it runs a bounded corpus of runtime intent and narrative cases and records per-case:

- semantic/contract result;
- latency in milliseconds;
- number of provider attempts;
- input/output/total tokens when reported by the provider;
- model ID and provider request IDs.

B12.4 must use a real configured credential/model if the release environment actually provides one. If not, the release evidence must record `not_configured`/unavailable and must not promote deterministic fake-provider tests into live-model evidence. The eval does not belong in ordinary `npm run verify` because it is external and potentially paid.

## 7. Known release constraints

- B13 Builder/deployment orchestration is not part of B12 release acceptance and must not be presented as shipped.
- Florence Engine production rollout is a separate operational decision; publication of the BFF does not imply the route is enabled.
- Production smoke proves public reachability and shell/API health; it does not prove Engine routing is enabled and intentionally does not mutate production state.
- Live provider/Codex claims remain limited to evidence actually obtained with real credentials/accounts.

## 8. Remaining release blockers

1. B12.4 bounded live provider eval + attempt/token/latency release statement;
2. acceptance-matrix consolidation for T01–33/T36–37;
3. release README/runbook/changelog and tested rollback procedure;
4. final exact-head CI, concrete RC commit and release tag.

No release tag should be created while any blocker above remains unresolved.
