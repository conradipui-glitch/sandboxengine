# B08-02 semantic audit — trusted backend plugin execution

Date: 2026-09-07

Scope: PR #29, branch `b08-02-backend-plugin-execution-contracts`.

Base: published B08-01 merge `375233479ab787a6215be7a1d6aab52ec9c47a74`, exact main CI `34105710910` success.

## Acceptance findings

### Registration / dispatch — PASS

- executable callbacks are trusted build-time registrations, separate from serializable manifest data;
- action/event IDs must be declared by the installed B08-01 plugin manifest;
- duplicate/missing registrations fail closed;
- lookup is registry-driven; no Core file was modified to branch on a plugin ID;
- public execution registry no longer leaks a mutable backing `Map` through `forEach`.

### Resolver authority — PASS

- resolver receives detached deeply frozen state and args;
- caller state mutation attempts do not escape the detached snapshot;
- resolver receives simulation time and a narrow deterministic RNG capability only;
- output is an exact bounded data-only `PluginActionPlan`;
- candidate state/state patch/unknown authority fields are rejected;
- blocked plans cannot hide duration/effects/events and must carry a reason;
- custom/non-canonical effects fail closed because `WorldState` v1 has no plugin extension namespace.

### Core integration — PASS

- canonical effects are applied by existing `tryApplyEffectBatch`;
- effect-bound failures remain atomic and expose no candidate state;
- duration uses existing `planTimeAdvance` / `applyTimeAdvancePlan` semantics;
- same state/args/seed gives the same plan, RNG provenance and Core candidate;
- RNG advancement is returned only on success.

### Dynamic scheduler — PASS after hardening

Initial post-green audit found a real gap: the standalone plugin scheduler handler returned canonical children, but there was no proof that those children entered Core's dynamic queue rather than a parallel plugin queue.

Hardening added a server adapter that routes registry-resolved plugin handlers through `processTimeAdvancePlan`. Regression tests prove:

- valid child events are processed by Core's canonical dynamic scheduler;
- generated child events in the past are rejected by Core;
- duplicate child event IDs are rejected by Core;
- failed scheduler processing publishes no advanced RNG state;
- plugin handlers may only emit canonical events with their own event source identity.

Core therefore remains owner of duplicate/past/order/event/step limits and the final transition.

### Architecture / determinism guard — PASS after hardening

The boundary checker now additionally enforces:

- Core cannot import `@living-history/plugins`;
- canonical plugin sources cannot import Core/Runtime/Control/Player/AI/Assets, app modules, filesystem/network/process/database/dynamic-code surfaces covered by the guard;
- obvious nondeterministic shortcuts `Math.random`, `Date.now` and `performance.now` are rejected.

This is a trusted-build static architecture guard, not an untrusted-JavaScript sandbox promise.

## CI evidence

- early generic execution head `234ac18ffd160de6d147579df774c230775ab549` → CI `34106576923` success;
- adversarial regression head `1e701a6ed509afa120b9b3157a4f9c7989afa756` → CI `34106751806` failed only because a test incorrectly assumed adjacent RNG seeds must map to different bounded buckets;
- facade hardening head `8b512837d50287460406b158081cceebb6d1c840` → CI `34107152241` found one missing public TypeScript type export;
- export fix `7154dfb5512b186728e2c8d6a25fea3ad9252f38` → CI `34107248938` success;
- scheduler-through-Core hardening `1b10aa7aaf25ae877f81575c192482a806b5a135` → CI `34108213347` success;
- architecture/determinism boundary hardening `a8cec6c6fc7e1721d5d9b965cb9e57c88040163a` → CI `34108349316` success.

## Follow-up, not blockers

- B08-02 does not include the concrete `dice-check` plugin; B08-03 owns that proof.
- No public Runtime plugin command endpoint is added here.
- No Studio plugin form/UI renderer is added here.
- Plugin code is trusted in-process build code; no third-party sandbox/marketplace security claim is made.
- Manifest custom effect IDs are not executable until a separately versioned `WorldState` extension contract exists.
- Runtime/publish enforcement of release plugin requirements remains a later integration concern.

## Verdict

Unresolved **BLOCKER = 0**.

B08-02 is functionally accepted and may proceed to the standard Publication Gate: docs/current-head CI → ready → pinned merge → exact merge-SHA main push CI.
