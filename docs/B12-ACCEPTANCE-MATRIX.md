# B12 mandatory acceptance matrix

Updated: 2026-09-08  
Release branch: `b12-release-hardening` / PR #36  
Primary exact regression evidence: CI #698 / run `34243238408` on implementation head `6f5588b2d88870f89a002b6db84867e1b6a3bc41`  
Production smoke: `sandbox` run `34239102418`  
Live-eval availability probe: run `34243952551`

This matrix consolidates T01–T33 and T36–T37 from `docs/SPECIFICATION.md`. T34–T35 and the Builder-specific code-isolation part of T33 belong to B13 by specification and are not silently counted as B12 release capability.

Status vocabulary:

- **PASS** — required behavior is exercised by deterministic or production evidence already in the release chain.
- **PASS / SCOPED** — accepted for the explicitly stated standalone Engine release boundary; broader platform claims are excluded.
- **PARTIAL / RELEASE GAP** — meaningful evidence exists, but one required part is not actually exercised yet.
- **LIVE UNAVAILABLE** — deterministic boundary exists, but an actual external account/provider run was unavailable; no fake claim is substituted.
- **DEFERRED B13** — specification explicitly places this part outside B12.

| ID | Status | Release evidence / limitation |
|---|---|---|
| T01 | **PASS** | Core action/effect tests prove resource-limited partial paint, exact completed units/time and blocked repeat without extra time. |
| T02 | **PASS** | Intent/Core regressions preserve negation/hypothetical boundaries; player consent/signature is never fabricated from text that does not authorize it. |
| T03 | **PASS** | Location/availability conditions and social-agency tests prevent impossible local interaction/teleport-style presence assumptions. |
| T04 | **PASS** | Social-agency + intent corpus keep request, permission and future consent distinct. |
| T05 | **PASS** | Scheduler tests prove ordered mid-action events and that later steps observe the changed world state. |
| T06 | **PASS** | Clock/deadline tests cover equal-time completion/deadline ordering and midnight arithmetic. |
| T07 | **PASS** | Item/atomic effect tests prevent double location and reject invalid transfer/consume batches without partial mutation. |
| T08 | **PASS** | Scheduler event-step limits reject runaway immediate-event chains without partial commit. |
| T09 | **PASS** | Intent tests cover unknown/ambiguous/multi-action/stale clarification paths without inventing actions. |
| T10 | **PASS** | Runtime storage/API tests prove same-key replay and same-key/different-request conflict with a single transition. |
| T11 | **PASS** | Operation claim/revision/fencing tests prove concurrent commands cannot both own/commit the same revision. |
| T12 | **PASS** | SQLite restart suite proves crash-before-commit recovery, lost-response replay, expired lease reacquire and stale fencing rejection. |
| T13 | **PASS** | AI failure tests prove intent timeout/invalid output does not consume a turn; narrator failure falls back without duplicating gameplay mutation. |
| T14 | **PASS** | Narrator/output validation rejects unknown speakers, illegal effects and unsafe references; safe fallback does not expose hidden state. |
| T15 | **PASS** | Guest/project/session authorization and public projection tests deny cross-session/project access and keep secret/full state out of Player responses. |
| T16 | **PASS** | Prompt-injection corpus cannot grant money/state mutation outside allowed action rules. |
| T17 | **PASS** | Compile/plugin/publication gates reject broken references, duplicate IDs, unknown/incompatible plugins and report exact validation failures. |
| T18 | **PASS** | Immutable release/session pinning + publication rollback tests prove active sessions stay on their release while future sessions follow the current pointer. B11 companion routing adds the same invariant across legacy/Engine runtimes. |
| T19 | **PASS** | Presentation executor tests cover sequence/parallel, skip/reduced motion, blocked audio/missing resource fallback while gameplay state remains identical. |
| T20 | **PASS** | Player presentation/replay tests restore the last frame and reject duplicate/old operation effects after reload/retry. |
| T21 | **PASS** | B09 full-author-cycle and B10 canonical regressions cover create/edit/validate/frozen playtest/publish path without hand-editing quest JSON. |
| T22 | **PASS** | Draft revision/conflict tests and stale AI proposal checks prevent silent overwrite and require explicit compare/retry/apply. |
| T23 | **PASS** | `dice-check` plugin tests prove deterministic seed behavior, registration without Core quest/plugin ID branches and text fallback when UI capability is absent. |
| T24 | **PASS** | `docs:check`, generated contract checks and registry/docs gates fail on drift and are part of root verify. |
| T25 | **PASS** | Portability/import tests cover valid export/import plus traversal/size/secret-shaped input rejection; exports remain structurally secret-free. |
| T26 | **PASS** | Real `examples/transfer-desk` proves a different item/social/resource quest works through shared Core/Runtime without Florence-specific branches. |
| T27 | **PASS** | Published B11 semantic acceptance preserves frozen Florence source mapping across canonical, compromise, refusal/authorship, conditional and withdrawal routes; migrated assets are pinned and verified. |
| T28 | **PASS / SCOPED** | B12.2 proves clean SQLite backup/restore, restart/recovery, assets and idempotent replay; B12.3 proves upstream 429 no-turn save integrity. Scope is standalone Engine SQLite/repository assets, not Cloudflare Durable Object backup. |
| T29 | **PARTIAL / RELEASE GAP** | Onboarding tests prove repeat/skip/back, optional failure-safe preference, real Studio anchors and no AI/network dependency; Studio test proves responsive CSS at `max-width: 680px`. A real browser/mobile-width focus+keyboard interaction has not yet been executed. |
| T30 | **PARTIAL / LIVE UNAVAILABLE** | Deterministic provider/profile/custom-endpoint/capability tests are green. One-shot B12 live eval run `34243952551` found `LHE_EVAL_API_KEY` and `LHE_EVAL_MODEL` unset, so no real provider/model claim is made. |
| T31 | **PASS** | Quota tests preserve zero vs unknown/null, separate management/inference credentials, tolerate denied management endpoints, expose stale state and avoid fabricated balance/tokens. |
| T32 | **PASS** | AuthorJob/checkpoint/busy-control tests cover multi-block creation, retry/no duplication, persisted progress, pause/resume and budget/rate-limit handling without draft corruption. |
| T33 | **PASS for B12 author boundary; DEFERRED B13 for Builder code isolation** | MCP/Skill broker/task-package tests deny secret/shell/deploy capability escalation and permission widening. Specification assigns Builder repository/deployment code isolation to B13. |
| T36 | **PASS** | Agent-kit/docs applicability, broker pinning/fallback and MCP/Skill lifecycle tests keep active-task version/permissions stable when external capability is unavailable or changes. |
| T37 | **PASS deterministic boundary; LIVE UNAVAILABLE** | Codex adapter/controller tests cover access failure/expiry, account isolation, quota and logout without paid-API fallback. No authenticated live Codex subscription run is claimed. |

## Current B12 gaps surfaced by consolidation

### G1 — T29 browser/mobile interaction

This is an actionable release gap. A bounded browser smoke must use the actual built Studio at a mobile-width viewport and prove at minimum:

1. Studio loads at ~360 px width without horizontal UI loss that blocks the authoring path;
2. onboarding can be started/skipped/replayed;
3. an actual editable control can receive focus and keyboard input while the onboarding/help surface is available;
4. the input value survives the interaction and is not hidden behind a blocking overlay.

A CSS regex alone is not sufficient evidence.

### G2 — T30 live provider evidence

Availability probe `34243952551` ran the real `npm run eval:ai` entry point with the documented CI configuration names and returned:

- status `not_configured`;
- provider label `https://openrouter.ai/api/v1`;
- model `null`;
- no live cases, tokens, attempts or latency to report.

This is an environment/configuration limitation, not a passed live eval. B12 may continue with independent release gates, but final release documentation must retain this limitation until a real `LHE_EVAL_API_KEY` + `LHE_EVAL_MODEL` is intentionally configured and one bounded run is recorded.

## Next bounded action

Close **G1/T29** with a one-shot, read-only browser smoke in CI. Do not add a permanent browser framework to the runtime solely for release evidence unless the smoke exposes a real product defect that needs a durable regression test.

After G1: release README/runbook/changelog + rollback drill, then final RC review. G2 remains explicitly live-unavailable unless real credentials are supplied/configured.
