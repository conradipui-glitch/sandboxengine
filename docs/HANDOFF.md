# Передача работы

Обновлено: 2026-09-07

Текущий блок: **B08-02 — trusted backend plugin execution contracts**  
База: published B08-01 merge `375233479ab787a6215be7a1d6aab52ec9c47a74`  
B08-01 main CI: `34105710910` — success  
Ветка: `b08-02-backend-plugin-execution-contracts`  
PR: #29  
Статус: **functional accepted; hardening CI `34108349316` success на `a8cec6c6fc7e1721d5d9b965cb9e57c88040163a`; semantic audit BLOCKER=0; docs/current-head Publication Gate next**

## Published foundation

B01–B07 published.  
B08-01 published: trusted manifest schema/API versioning, deterministic dependency registry, release compatibility and generated installed-plugin metadata.

B08-01 publication evidence: merge `375233479ab787a6215be7a1d6aab52ec9c47a74`, exact `main` push CI `34105710910` success.

## B08-02 implementation

Authority rule:

`trusted build registration -> detached/frozen resolver input -> bounded data plan/events -> existing Core effect/time/scheduler gates -> candidate state`

Plugin code never returns authoritative `WorldState` and never receives commit/storage/HTTP/Core mutation callbacks through the plugin API.

### Resolver / action host

- action resolver registration is separate from serializable manifest;
- action ID must be manifest-declared for the installed plugin;
- args are JSON-validated/frozen before resolver invocation;
- resolver receives detached deeply frozen state, simulation clock and bounded deterministic RNG;
- resolver throws/RNG failures become explicit plugin failures;
- exact plan shape rejects candidate state/state patches/callbacks/unknown authority fields;
- blocked action cannot hide time/effects/events;
- canonical effects are applied only through Core `tryApplyEffectBatch`;
- duration is applied only through Core time planning/application;
- advanced RNG state is returned only on success.

### Scheduler handler

- handler identity is registry/manifest driven;
- handler receives canonical event + detached state + deterministic scheduler context + bounded RNG;
- handler returns canonical child events only;
- child source identity is constrained to the registered plugin event type;
- server adapter routes handler children into Core `processTimeAdvancePlan`;
- Core, not plugin code, owns generated child duplicate/past/effective-order/event-limit/step-limit checks and final state transition;
- failed Core scheduler transition returns no advanced RNG state.

### Custom state effects

Manifest custom effect IDs remain metadata only. `WorldState` v1 has no `extensions[pluginId]`, so B08-02 intentionally rejects non-canonical effects rather than inventing state patches.

### Static architecture guard

- Core cannot import `@living-history/plugins`;
- plugin package cannot import Core/Runtime/Control/Player/AI/Assets or app modules;
- plugin package guard rejects DB/network/process/dynamic-code surfaces covered by the checker;
- obvious `Math.random` / `Date.now` / `performance.now` shortcuts are rejected.

This is trusted in-process build code with static architecture guards, **not** a sandbox for arbitrary third-party JavaScript.

## Evidence

- generic host `234ac18ffd160de6d147579df774c230775ab549` → CI `34106576923` success;
- adversarial regressions exposed one false adjacent-seed assumption in the test at CI `34106751806`;
- facade hardening then exposed one missing TypeScript re-export at CI `34107152241`;
- fixed head `7154dfb5512b186728e2c8d6a25fea3ad9252f38` → CI `34107248938` success;
- post-green audit found scheduler child path not yet proven through Core;
- scheduler-through-Core head `1b10aa7aaf25ae877f81575c192482a806b5a135` → CI `34108213347` success;
- final boundary hardening `a8cec6c6fc7e1721d5d9b965cb9e57c88040163a` → CI `34108349316` success;
- semantic audit: `docs/audits/2026-09-07-b08-02-semantic-audit.md` → unresolved BLOCKER **0**.

ADR: `docs/decisions/0027-trusted-backend-plugin-execution.md`.  
Worklog: `docs/worklog/2026-09-07-b08-02.md`.

## Honest scope boundary

Not implemented in B08-02:

- concrete installed `dice-check` plugin;
- custom WorldState extension/reducer contract;
- public Runtime plugin endpoint;
- Studio plugin editor/forms;
- UI component plugin renderer;
- untrusted code sandbox/marketplace;
- publish/start enforcement of release plugin requirements.

## Publication Gate

1. final full CI on exact docs/current head;
2. update PR #29 body with final evidence/audit;
3. mark PR #29 ready;
4. merge pinned to exact expected head;
5. verify exact merge-SHA push-to-main CI;
6. only then call B08-02 published.

## Next

After verified B08-02 publication: **B08-03 — `dice-check` proof plugin + authored schema/recipe + compatibility proof**, exactly from the verified B08-02 merge SHA.

Do not start B08-03 before that publication check.
