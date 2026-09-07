# B08-03 — dice-check extensibility proof plugin

## Goal

Complete canonical B08 §12.4 by adding one real trusted installed plugin, `dice-check`, through the published B08-01 manifest/registry and B08-02 execution host without adding plugin-specific branches to Core.

Base: published B08-02 merge `a3eef28d106d89bdc4e05cf5c9fd7c1eb61e97e1`, exact main CI `34108753710` — success.

Specification source: §12.1–12.4 and §13 agent-contract requirements.

## Main invariant

**`dice-check` is ordinary trusted plugin code discovered/validated through the generic registry and executed through the generic B08-02 host. Core must not know the plugin ID, action ID or dice semantics.**

## Do

### 1. Real installed plugin

Add one build-installed plugin with stable namespaced identity:

- plugin ID: `dice-check`;
- version: `1.0.0`;
- capability: `dice-check.capability.skill-check`;
- authored schema: `dice-check.schema.skill-check` v`1.0.0`;
- action: `dice-check.action.skill-check`;
- recipe: `dice-check.recipe.skill-check`;
- optional block metadata ID: `dice-check.block.skill-check` if useful for Studio discovery.

The concrete build registry must no longer advertise zero installed plugins. Build metadata must match the actual plugin manifest and generated agent docs must update deterministically.

### 2. Authored skill-check definition

Add a strict plugin-owned JSON Schema + runtime validator for a reusable skill-check definition. Minimum authored fields:

- stable definition ID;
- difficulty;
- modifier;
- duration seconds;
- success/failure author-declared canonical-effect templates;
- bounded success/failure narrative templates.

Bounds must be explicit. Effects may instantiate only the already-published canonical gameplay effect types; arbitrary state patches/custom reducers are forbidden.

Do **not** widen core `Block` / `QuestRelease` v1 silently. Plugin-authored data lives in a versioned plugin sidecar/descriptor.

### 3. Schema-driven Studio descriptor

Add bounded UI metadata for an ordinary generated form:

- labels/help for difficulty/modifier/duration;
- control type and min/max aligned with JSON Schema;
- success/failure effect sections;
- narrative-template fields.

This is form metadata, not arbitrary HTML/React code and not a new Studio redesign.

### 4. Deterministic resolver

Provide a trusted B08-02 registration factory bound to a validated authored definition.

Resolver must:

1. receive no player authority to choose effects/difficulty/modifier;
2. draw exactly one d20 result from the host RNG (`drawInt(20) + 1`);
3. compute `total = roll + modifier`;
4. compare against authored difficulty;
5. return an executed generic `PluginActionPlan` with one selected authored effect branch;
6. emit only canonical effects with host/action source identity;
7. expose success/failure through a bounded reason code and deterministic result projection;
8. use existing B08-02 duration/Core time path.

Same definition + state + args + seed/stream must produce the same validated plan, RNG provenance, projected result and candidate state.

### 5. Narrative recipe / text result

Add a recipe/template document and a pure renderer/projector that turns the validated plan + definition into a player-safe result containing:

- roll;
- modifier;
- total;
- difficulty;
- outcome;
- bounded rendered narrative text.

Template substitution is allowlisted data substitution only; no eval/HTML/script execution.

Text representation is mandatory. A custom visual widget is optional and is not required to prove B08.

### 6. Release/playtest compatibility sidecar

Because published `QuestRelease`/`FrozenPlaytestRecord` v1 do not contain plugin requirements, introduce a B08-owned immutable sidecar contract bound to the exact frozen artifact identity/content hash rather than widening those v1 contracts.

The sidecar must include:

- target quest/release/playtest identity or compiled content hash;
- `PluginReleaseRequirements` for `dice-check` version/capability/schema;
- deterministic validation against an installed registry.

Required proof:

- current build with `dice-check` is compatible;
- a registry built without `dice-check` yields explicit missing-plugin incompatibility;
- an incompatible version/capability/schema fails closed;
- start/publish preflight helper returns a blocking result when requirements are not met.

B09 may later embed/adapt this sidecar into the production publish manifest without changing old `QuestRelease` v1.

### 7. Generated agent contract

Update deterministic generated docs so the current build truthfully advertises:

- installed `dice-check@1.0.0`;
- its capability ID;
- its schema version;
- its action/recipe metadata when implemented;
- a changed plugin registry hash.

Do not advertise a public Runtime endpoint unless one is actually implemented.

### 8. Architecture proof

Regression must prove:

- no `dice-check` / `dice-check.action.skill-check` string appears in `packages/core/src`;
- no Core source imports the plugin package;
- plugin package keeps B08-02 no-Core/no-network/no-process/determinism guards;
- removing plugin from registry causes compatibility failure rather than fallback to built-in behavior.

## Tests

Minimum deterministic regressions:

1. manifest/schema/form/recipe identities agree;
2. installed registry metadata equals actual plugin manifest identity/capabilities/schemas;
3. valid definition passes schema/runtime validation;
4. malformed bounds/template/effect template fails closed;
5. resolver draws exactly one d20 value from host RNG;
6. same seed/input gives byte-equivalent plan/result/candidate;
7. success chooses only success effects; failure chooses only failure effects;
8. plugin effect templates instantiate canonical `GameplayEffect` and Core applies them atomically;
9. difficulty/modifier/effects cannot be injected through player action args;
10. narrative renderer substitutes only allowlisted placeholders and stays text-only;
11. installed registry satisfies release sidecar requirements;
12. registry without plugin fails `MISSING_PLUGIN` and preflight blocks;
13. incompatible plugin version/capability/schema blocks;
14. generated agent docs advertise only implemented `dice-check` metadata;
15. Core contains no plugin-specific branch/import;
16. root `npm run verify` green.

## Functional acceptance

B08-03 is accepted when §12.4 is demonstrated end-to-end at code/contract level:

`installed manifest -> plugin schema/form/recipe -> trusted registration -> B08-02 resolver host -> canonical Core effects/time -> deterministic result`,

and an exact frozen-artifact compatibility sidecar blocks when the required plugin is absent/incompatible.

Semantic audit must have unresolved `BLOCKER = 0`.

## Not now

- custom WorldState plugin extension reducer;
- arbitrary third-party plugin loading/sandbox/marketplace;
- public Runtime generic plugin endpoint unless required by an existing wired product path;
- final Studio redesign;
- B09 authentication/publish UX;
- B10 Author AI helper;
- Florence migration.

## Next

After verified published B08-03 and canonical B08 audit/closure: **B09 — authentication / publish boundary**, exactly from the verified B08 merge SHA.
