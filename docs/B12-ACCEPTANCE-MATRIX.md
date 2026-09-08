# B12 mandatory acceptance matrix

Updated: 2026-09-08  
Published release: `v0.1.0` → `3e6fcfd9c42910561500aca8c73e639d9bcf2f9b`  
Final cleaned PR CI: #728 / run `34251382755` — **PASS**  
Published `main` CI: #729 / run `34251551857` — **PASS**  
Production smoke: `sandbox` run `34239102418` — **PASS**  
T29 real browser smoke: run `34246143800` — **PASS**  
Configured live provider eval: run `34250711595` — **PASS contract / quality limitation**

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
| T18 | **PASS** | B12 permanent rollback drill proves immutable current-pointer rollback, restart persistence and old/new session pinning. |
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
| T29 | **PASS** | One-shot real Chromium run `34246143800`: 360×800, no horizontal overflow, auto-tour/skip/help/Escape focus return/replay/next/back/skip, real project-title keyboard input preserved, 0 page errors and 0 unexpected HTTP failures. |
| T30 | **PASS / LIVE QUALITY LIMITATION** | Real OpenRouter eval `34250711595` with `deepseek/deepseek-v4-flash-0731`: structural contract 12/12; semantic 5/12; 16 attempts; mean latency 12,176 ms; max 25,002 ms. Provider connectivity/capability boundary is proven; this model is not qualified as a recommended intent model by this score. |
| T31 | **PASS** | Quota null/0/stale semantics, management-vs-inference credentials and denied quota endpoint behavior. Live provider usage was incomplete, so aggregate tokens remain `null` rather than invented. |
| T32 | **PASS** | Author jobs persist/replay/pause/resume/cancel without duplicate mutation. |
| T33 | **PASS for B12 author boundary; DEFERRED B13 for Builder code/deploy** | Skills/MCP broker denies secret/shell/deploy capability escalation; Builder repository/deployment authority is B13. |
| T36 | **PASS** | Agent-kit/Skill/MCP applicability and version/permission pinning fail closed. |
| T37 | **PASS deterministic boundary; LIVE UNAVAILABLE** | Codex adapter/controller covers protocol/auth/quota/logout/isolation with no paid fallback; no authenticated live subscription run is claimed. |

## Release-wide operational evidence

- dependency graphs: 0 known vulnerabilities at B12 security gate;
- backup/restore: 11 SQLite pages, exact restored session/release/turn and 12/12 Florence hashes;
- rollback: publish r1 → r2 → rollback r1, restart, immutable hashes/history and session A/B/C pinning preserved;
- persistent entrypoint: Runtime `/healthz` 200, Control safe read 200, SQLite created, SIGTERM exit code 0;
- external production shell/API smoke: PASS on deployed companion Worker;
- live provider: OpenRouter + `deepseek/deepseek-v4-flash-0731`, contract-safe 12/12 with explicit semantic-quality limitation;
- final published Engine merge: `3e6fcfd9c42910561500aca8c73e639d9bcf2f9b`, main CI #729 success;
- release tag: `v0.1.0` verified on that exact merge SHA.

## B12 external provider evidence

Run `34250711595` executed the real opt-in evaluator with the configured repository API secret and an explicit model. Safe summary:

- status: `completed`;
- provider: `https://openrouter.ai/api/v1`;
- model: `deepseek/deepseek-v4-flash-0731`;
- cases: 12;
- contract: 12/12 (100%);
- semantic: 5/12 (41.7%);
- attempts: 16;
- mean latency: 12,176 ms;
- max latency: 25,002 ms;
- aggregate tokens: `null` because provider usage was incomplete across cases.

The release does not convert a low semantic score into a model-quality PASS. T30 passes because the real compatible-provider path, safe capability boundary, error behavior and telemetry are proven. Model selection remains an operational configuration and this specific run does not establish DeepSeek V4 Flash as the recommended intent model.

The temporary secret-bearing eval workflow was removed after the run. Authenticated live Codex subscription evidence remains unavailable and is documented under T37; deterministic Codex boundary behavior is covered.

## Publication result

B12 is complete. PR #36 was merged as `3e6fcfd9c42910561500aca8c73e639d9bcf2f9b`, `main` CI #729 passed on that exact commit, and tag `v0.1.0` resolves to the same SHA. Temporary tag infrastructure was removed after verification.

B13 may now start as a separate acceptance block.
