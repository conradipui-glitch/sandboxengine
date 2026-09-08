# B12 mandatory acceptance matrix

Updated: 2026-09-08  
Release branch: `b12-release-hardening` / PR #36  
Latest full regression before docs sync: CI #713 / run `34246765104` on head `847aa22f3e4457bccd5c4dc19ab6d27f26941afb` — **PASS**  
Production smoke: `sandbox` run `34239102418` — **PASS**  
T29 real browser smoke: run `34246143800` — **PASS**  
Live-eval availability probe: run `34243952551` — **not_configured**

This matrix consolidates T01–T33 and T36–T37 from `docs/SPECIFICATION.md`. T34–T35 and Builder-specific code/deployment isolation are B13 scope and are not silently counted as B12 capability.

| ID | Status | Release evidence / limitation |
|---|---|---|
| T01 | **PASS** | Core partial/executed/blocked resource math and time invariants. |
| T02 | **PASS** | Negation/hypothetical/agency boundaries; consent is not fabricated. |
| T03 | **PASS** | Presence/location conditions reject impossible local interaction. |
| T04 | **PASS** | Request, permission and response remain distinct social acts. |
| T05 | **PASS** | Mid-action events are ordered and later steps observe changed state. |
| T06 | **PASS** | Equal-time deadline ordering and midnight arithmetic are deterministic. |
| T07 | **PASS** | Item/effect batches are atomic and cannot double-place items. |
| T08 | **PASS** | Immediate-event chains hit a global bounded step budget without partial commit. |
| T09 | **PASS** | Unknown/ambiguous/multi-action/stale clarification paths do not invent actions. |
| T10 | **PASS** | Same-key replay is byte-stable; changed request cannot reuse the key. |
| T11 | **PASS** | Concurrent commands cannot both own/commit one revision. |
| T12 | **PASS** | SQLite lost-response/crash/reacquire/fencing restart recovery. |
| T13 | **PASS** | AI intent/narrator failure never duplicates or consumes gameplay incorrectly. |
| T14 | **PASS** | Narration validation/fallback rejects hidden/unknown authority. |
| T15 | **PASS** | Guest/project/session isolation and deny-by-default Player projection. |
| T16 | **PASS** | Prompt injection cannot widen action/effect authority. |
| T17 | **PASS** | Compile/plugin/publication validation fails closed on incompatible data. |
| T18 | **PASS** | B12 permanent rollback drill proves immutable current-pointer rollback, restart persistence and old/new session pinning. CI #713. |
| T19 | **PASS** | Presentation sequence/parallel/skip/failure fallback leaves gameplay authoritative state unchanged. |
| T20 | **PASS** | Reload/retry restores committed frame and never replays obsolete presentation effects. |
| T21 | **PASS** | Human Studio author cycle reaches validation/playtest/publication without manual quest JSON editing. |
| T22 | **PASS** | Draft and AI proposal conflicts are visible and never silently overwrite. |
| T23 | **PASS** | `dice-check` plugin deterministic and isolated from Core-specific branches. |
| T24 | **PASS** | Generated docs/registry drift is CI-gated. |
| T25 | **PASS** | Export/import portability plus traversal/size/secret rejection. |
| T26 | **PASS** | Transfer Desk proves a second causal/item/social quest through generic Core/Runtime. |
| T27 | **PASS** | Published B11 Florence semantic routes and migrated asset provenance remain pinned. |
| T28 | **PASS / SCOPED** | Backup/restore, restart, startup/shutdown, assets, 429 no-turn save integrity all pass for standalone SQLite Engine. No Cloudflare DO backup claim. |
| T29 | **PASS** | One-shot real Chromium run `34246143800`: 360×800, no horizontal overflow, auto-tour/skip/help/Escape focus return/replay/next/back/skip, real project-title keyboard input preserved, 0 page errors and 0 unexpected HTTP failures. Canonical local auth-probe 404 was explicitly classified by existing access semantics. Temporary Playwright workflow was deleted afterwards. |
| T30 | **PARTIAL / LIVE UNAVAILABLE** | Deterministic OpenRouter/custom endpoint/capability tests pass. Live probe `34243952551` found no `LHE_EVAL_API_KEY`/`LHE_EVAL_MODEL`, so no real-model success/tokens/latency claim exists. |
| T31 | **PASS** | Quota null/0/stale semantics, management-vs-inference credentials and denied quota endpoint behavior. |
| T32 | **PASS** | Author jobs persist/replay/pause/resume/cancel without duplicate mutation. |
| T33 | **PASS for B12 author boundary; DEFERRED B13 for Builder code/deploy** | Skills/MCP broker denies secret/shell/deploy capability escalation; Builder repository/deployment authority is B13. |
| T36 | **PASS** | Agent-kit/Skill/MCP applicability and version/permission pinning fail closed. |
| T37 | **PASS deterministic boundary; LIVE UNAVAILABLE** | Codex adapter/controller covers protocol/auth/quota/logout/isolation with no paid fallback; no authenticated live subscription run is claimed. |

## Release-wide operational evidence

- dependency graphs: 0 known vulnerabilities at B12 security gate;
- backup/restore: 11 SQLite pages, exact restored session/release/turn and 12/12 Florence hashes;
- rollback: publish r1 → r2 → rollback r1, restart, immutable hashes/history and session A/B/C pinning preserved;
- persistent entrypoint: Runtime `/healthz` 200, Control safe read 200, SQLite created, SIGTERM exit code 0;
- external production shell/API smoke: PASS on deployed companion Worker.

## Remaining B12 gap

### G2 — configured live provider evidence

Run `34243952551` executed the real opt-in evaluator entrypoint but the release environment supplied neither required key nor model. Result:

- `status: not_configured`;
- provider label `https://openrouter.ai/api/v1`;
- model `null`;
- no live cases, attempts, token usage or latency exists to report.

This is the only unresolved mandatory external B12 evidence after the autonomous gates above. It must not be converted into PASS using fake-provider tests.

Authenticated live Codex subscription evidence is also unavailable and remains a release limitation, but deterministic T37 boundary behavior is covered.

## Finalization rule

Do not create the B12 release tag until one intentionally configured bounded live provider eval records the real provider/model and case telemetry required by the B12 specification, followed by final exact-head `npm run verify` and docs gate.
