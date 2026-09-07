# ADR 0028 — dice-check proof plugin and frozen authored sidecar

Status: Accepted

Date: 2026-09-07

## Context

B08 requires one concrete plugin to prove that the published manifest/registry and generic execution host are sufficient to add gameplay without adding plugin-specific branches to Core. Canonical §12.4 names `dice-check` as that proof: authored difficulty/modifier, one deterministic d20 draw, authored success/failure effects, text narration and compatibility failure when the plugin is absent.

Published `QuestRelease` and `FrozenPlaytestRecord` v1 intentionally do not contain plugin-owned authoring data. Silently widening those contracts in B08 would break the versioning rule established earlier.

A post-green B08-03 audit also found a concrete freeze gap: plugin requirements were bound to an artifact hash, but `DiceCheckDefinition[]` could still be supplied to the executable registration independently. The same frozen artifact could therefore be paired with different authored difficulty/effects unless plugin-owned authoring data was bound as well.

## Decision

Ship `dice-check@1.0.0` as trusted build code registered through the generic B08 registry/execution APIs.

The plugin owns:

- capability `dice-check.capability.skill-check`;
- action `dice-check.action.skill-check`;
- authored schema `dice-check.schema.skill-check@1.0.0`;
- recipe `dice-check.recipe.skill-check`;
- schema-driven Studio form metadata;
- deterministic result projection and text-only narrative templating.

Runtime action args may select only an already-authored `definitionId`. Difficulty, modifier, duration, effects and narrative cannot be supplied by the player request.

The resolver draws exactly once through the host RNG using `drawInt(20) + 1`. It chooses one authored branch and returns only canonical `GameplayEffect[]`; Core remains responsible for effect invariants, time advancement and candidate state.

Plugin compatibility and plugin-authored content remain sidecars rather than widening v1 Core/Control contracts:

1. `PluginArtifactRequirementsSidecar` binds required plugin version/capability/schema to an exact artifact hash.
2. `DiceCheckAuthoredSidecar` binds the validated authored definitions themselves to the same exact artifact hash.
3. `bindDiceCheckRegistrationToArtifact` refuses to materialize an executable registration until the authored sidecar shape and artifact hash match.

Created sidecars are detached and deeply frozen. The registration factory clones/validates definitions again so later caller mutation cannot change the executable mechanic.

## Authority boundary

Core contains no `dice-check` ID, dice arithmetic, plugin import or plugin-specific dispatch. The plugin package remains covered by the B08 static no-Core/no-DB/no-network/no-process/dynamic-code and deterministic-time/entropy guards.

`dice-check` is trusted in-process build code, not sandboxed third-party JavaScript.

## Consequences

- B08 demonstrates the complete extension chain without changing Core or v1 quest/playtest schemas.
- Removing the plugin from the installed registry makes a requiring artifact explicitly incompatible.
- Frozen authored dice definitions can no longer drift independently of the artifact identity in the proof path.
- B09 must persist and enforce these sidecars in the production publish/start boundary; B08 provides the blocking preflight contracts but does not invent a public publish endpoint early.
- Custom `WorldState` plugin reducers and arbitrary plugin UI remain future versioned work, not implied by this proof.
