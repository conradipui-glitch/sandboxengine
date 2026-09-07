# Передача работы

Обновлено: 2026-09-07

Текущий блок: **B08-03 — `dice-check` extensibility proof plugin**  
База: published B08-02 merge `a3eef28d106d89bdc4e05cf5c9fd7c1eb61e97e1`  
B08-02 main CI: `34108753710` — success  
Ветка: `b08-03-dice-check-proof-plugin`  
PR: #30  
Статус: **functional accepted; artifact-binding hardening head `339b01b99ea70d8e2b9db958384d95be66598f8b` → CI `34112797727` success; B08-03 semantic BLOCKER=0; canonical B08 BLOCKER=0; docs/current-head Publication Gate next**

## Published foundation

B01–B07 published.  
B08-01 published: merge `375233479ab787a6215be7a1d6aab52ec9c47a74`, exact main CI `34105710910` success.  
B08-02 published: merge `a3eef28d106d89bdc4e05cf5c9fd7c1eb61e97e1`, exact main CI `34108753710` success.

## Canonical B08 architecture

`trusted data manifest -> deterministic installed registry -> trusted build registration -> frozen resolver input + deterministic RNG -> bounded plugin plan -> existing Core effect/time/scheduler gates`

Core never learns plugin-specific IDs or mechanics.

## B08-03 proof plugin

Current build contains one real trusted plugin:

- `dice-check@1.0.0`;
- capability `dice-check.capability.skill-check`;
- action `dice-check.action.skill-check`;
- schema `dice-check.schema.skill-check@1.0.0`;
- block metadata `dice-check.block.skill-check`;
- recipe `dice-check.recipe.skill-check`;
- schema-driven Studio form metadata.

### Author authority

A `DiceCheckDefinition` owns difficulty, modifier, duration, success/failure canonical-effect templates and bounded narrative templates.

Player/runtime args are exact and may contain only `definitionId`. The player cannot inject difficulty/modifier/effects/narrative.

### Determinism / Core path

Resolver draws exactly one value with host `drawInt(20) + 1`, computes total/outcome and selects one authored effect branch. Effects remain canonical Core effects. Duration uses existing Core time processing. Same state/definition/args/seed is reproducible.

### Frozen authored data

Post-green audit found and fixed one real blocker: definitions were initially independent from the frozen artifact hash.

Now:

- `PluginArtifactRequirementsSidecar` binds plugin compatibility requirements to an exact artifact hash;
- `DiceCheckAuthoredSidecar` binds the validated authored definitions to that same exact artifact hash;
- `bindDiceCheckRegistrationToArtifact` refuses mismatch before a registration/Core execution exists;
- sidecar definitions are detached/deep-frozen and cloned/validated again into the executable registration.

This preserves old `QuestRelease`/`FrozenPlaytestRecord` v1 while making the proof mechanic frozen at code/contract level.

### Missing plugin

A registry without `dice-check` returns explicit `MISSING_PLUGIN`; incompatible version/capability/schema also blocks generic preflight. There is no silent built-in fallback.

## Generated agent contract

`docs:generate` now truthfully exposes one installed plugin, its capability/schema/block/action/recipe metadata and changed plugin registry hash. No public generic plugin endpoint is advertised because none exists.

Generated-doc sync head `8c23a3358e5783ee2b4d998d6ae525d478b0f7d2` → CI `34112482535` success.

## Evidence / audits

- B08-03 hardening head `339b01b99ea70d8e2b9db958384d95be66598f8b` → CI `34112797727` success;
- ADR: `docs/decisions/0028-dice-check-proof-and-frozen-authored-sidecar.md`;
- B08-03 audit: `docs/audits/2026-09-07-b08-03-semantic-audit.md` → BLOCKER **0**;
- canonical B08 audit: `docs/audits/2026-09-07-b08-canonical-audit.md` → BLOCKER **0**;
- worklog: `docs/worklog/2026-09-07-b08-03.md`.

## Honest scope boundary

Not implemented in B08:

- untrusted code sandbox/marketplace;
- remote/dynamic plugin loading;
- custom WorldState plugin reducers;
- public generic Runtime plugin action endpoint;
- complete Studio plugin editor/custom result widget;
- production auth/publish persistence/enforcement of plugin sidecars.

B09 owns the last item and should wire the already-published B08 compatibility/authored-sidecar preflights into real publish/start authority.

## Publication Gate

1. commit docs/audits/status/handoff on the current B08-03 branch;
2. final full CI on that exact head;
3. update PR #30 with final evidence;
4. mark PR #30 ready;
5. merge pinned to that exact expected head;
6. verify exact merge-SHA `event=push`, `head_branch=main` CI;
7. only then call B08 published;
8. create B09 exactly from the verified B08 merge SHA.
