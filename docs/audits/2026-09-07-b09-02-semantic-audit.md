# Semantic audit — 2026-09-07 — B09-02

## Scope

Audit B09-02 against `docs/tasks/B09-02-immutable-release-publish.md` after the first green implementation slices. The question is not whether CI is green, but whether the repository actually proves immutable release publication, exact pinned-session execution, restart behavior and truthful public capability exposure.

Base: published B09-01 merge `206ae32e1ce9f4a027c881e61d8e6e2163a4095d`.

## Result

Unresolved BLOCKER: **0**.

## Findings

### BLOCKER-01 — release authority existed without the required Control HTTP authority

**Finding:** Early B09-02 storage/build/publication code could be green while the required `GET/POST releases`, `publish` and `rollback` routes were still absent. That failed functional acceptance and would make the endpoint registry truthful only by continuing to hide B09-02.

**Resolution:** Added bounded release routes at the existing Control server boundary with B09-01 project roles, authenticated mutation CSRF, Origin/CORS policy and server-side authority. Tester cannot build; editor can build but cannot publish/rollback; owner owns pointer movement. Regression head `0828e8812fd878f833f9199302644170af3accf3`, CI `34145973151` success.

**Status:** resolved.

### BLOCKER-02 — a global execution context could violate pinned-session mechanics

**Finding:** Resolving only the new-session initial state from `currentReleaseId` is insufficient. If action execution continued through one global/static executor, a v1 session could execute v2 mechanics after publication. That would violate the main release-pinning invariant while `SessionRecord.release` still appeared correct.

**Resolution:** Published sessions now resolve action execution context from durable project binding + the session's exact pinned `questId + releaseId + contentHash`, never from current pointer. Regression explicitly publishes cost=1 v1 and cost=2 v2, then rolls back, proving old/new sessions keep their own mechanics. Head `4dc7217102f3a68f7fe0692a9d8d4ec2e75d74bf`, CI `34146359865` success.

**Status:** resolved.

### BLOCKER-03 — standalone production still had a static-template fallback

**Finding:** Even with a correct resolver available, `apps/server/src/main.ts` still composing `createMinimalPaintTemplate()` would mean the real production entrypoint did not use publication authority and could silently start content outside the Control release pointer.

**Resolution:** Standalone composition now opens SQLite Control release storage and durable published-session binding storage and runs Runtime in published mode. Static templates remain explicit dev/test mode only, and mixed static/published composition is rejected. Head `58c1acaea560547cf557fee0294d2a6d262bfa51`, CI `34146421428` success.

**Status:** resolved.

### BLOCKER-04 — restart proof covered release storage but not end-to-end pinned execution

**Finding:** Release rows/current pointer surviving reopen did not by itself prove that an existing Runtime session could reopen its project binding and continue executing the same exact release after process restart.

**Resolution:** Added process-like SQLite reopen regression covering release store, runtime storage, guest access and published-session binding together. The reopened server resolves and executes the existing session's exact pinned release. Head `674d8542dbb5ffb1612815133a1210cf7b867520`, CI `34146693272` success.

**Status:** resolved.

### DOC-01 — implemented release routes were not yet in generated capability truth

**Finding:** After HTTP implementation, the canonical endpoint registry/generated agent docs still omitted B09-02 routes. Advertising them early would have been wrong before implementation; leaving them hidden after implementation would also be wrong.

**Resolution:** Marked exactly four implemented release operations available and regenerated deterministic SKILL/OpenAPI/capabilities/compatibility files. Registry-only head `df1da54815d9de1f9cb76410c0d4e88310bf4b9a` correctly failed only `docs:check`; generated sync head `20bb2fc2be046abb04b77b838cf94692cabc51c7` passed CI `34147022847`.

**Status:** resolved.

## Non-blocking explicit limitation

The current published Runtime materializer supports the implemented unambiguous zero-or-one `core.action` routing shape. More than one authored `core.action` fails explicitly with `UNSUPPORTED_ACTION_ROUTING`; it does not guess order or silently choose one. This is acceptable for B09-02 because failure is explicit and preserves authority. Richer routing should be introduced only with an explicit later contract and regressions.

## Invariant review

- release content remains immutable after build: **pass**;
- exact validation/draft/artifact hashes are re-proved: **pass**;
- B08 compatibility is reused, not duplicated: **pass**;
- publish/rollback move only `currentReleaseId`: **pass**;
- owner/editor/tester authority is enforced server-side: **pass**;
- stale compare-and-set cannot overwrite newer pointer: **pass**;
- built-never-published release cannot be rollback target: **pass**;
- new sessions follow current pointer: **pass**;
- existing sessions remain pinned across publish and rollback: **pass**;
- missing/corrupt/incompatible release fails closed without alternate release/static fallback: **pass**;
- Runtime guest auth remains separate from Control owner auth: **pass**;
- SQLite reopen preserves release startability and existing pinned execution: **pass**;
- generated capabilities expose implemented B09-02 operations and no B09-03 operations: **pass**;
- Core/Runtime/Control package authority boundaries remain intact: **pass**.

## Gate

B09-02 semantic acceptance is complete with unresolved BLOCKER **0**. Remaining Publication Gate is mechanical only: final documentation-head CI, ready PR #32, pinned exact-head merge, and exact successful `push` CI on the resulting `main` merge SHA.
