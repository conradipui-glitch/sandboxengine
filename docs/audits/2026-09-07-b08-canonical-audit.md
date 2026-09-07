# Canonical B08 audit — extensibility without Core rewrites

Date: 2026-09-07

Scope: B08-01 → B08-03.

Published foundation:

- B08-01 merge `375233479ab787a6215be7a1d6aab52ec9c47a74`, exact main CI `34105710910` success;
- B08-02 merge `a3eef28d106d89bdc4e05cf5c9fd7c1eb61e97e1`, exact main CI `34108753710` success;
- B08-03 current accepted hardening head `339b01b99ea70d8e2b9db958384d95be66598f8b`, CI `34112797727` success.

## Canonical question

Can the engine add a real reusable gameplay mechanic through a trusted plugin without teaching Core about that plugin, while preserving determinism, authority boundaries and compatibility failure when the plugin is missing?

**Yes.**

## B08-01 — discovery / compatibility foundation — PASS

- data-only manifest schema and engine plugin API version are explicit;
- all plugin-owned IDs are namespaced;
- duplicate IDs, dependency mismatch/cycles and global collisions fail closed;
- registry order is deterministic and snapshots are frozen;
- release requirements report missing/incompatible plugin/capability/schema instead of silently skipping them;
- no dynamic import/eval/URL source loading or gameplay callback authority exists at the registry layer.

## B08-02 — generic trusted execution boundary — PASS

- executable registrations are trusted build-time code separate from manifests;
- resolver/event IDs must be declared by the installed registry;
- resolver sees detached frozen state/args, simulation time and bounded deterministic RNG only;
- output is bounded data, never authoritative WorldState/state patch/callbacks;
- canonical effects/time are applied only through existing Core gates;
- plugin scheduler children enter Core's dynamic scheduler queue, where Core owns duplicate/past/order/event/step limits;
- failure publishes neither candidate state nor advanced RNG state;
- Core is statically forbidden from importing the plugin package;
- plugin package is statically guarded from gameplay/storage/network/process/dynamic-code and obvious wall-clock/entropy shortcuts.

## B08-03 — concrete `dice-check` proof — PASS after semantic hardening

The real installed plugin adds:

- capability `dice-check.capability.skill-check`;
- action `dice-check.action.skill-check`;
- authored schema `dice-check.schema.skill-check@1.0.0`;
- recipe and schema-driven Studio form metadata;
- authored difficulty/modifier/duration and success/failure canonical-effect branches;
- one deterministic d20 draw from host RNG;
- player-safe deterministic text result projection.

Player args may select only an authored `definitionId`; they cannot choose dice parameters or effects.

The first post-green audit found one real freeze gap: authored definitions were not yet bound to the frozen artifact hash. B08-03 hardening added a versioned `DiceCheckAuthoredSidecar` and exact-hash registration gate. The proof now binds both plugin requirements and authored plugin mechanics to the frozen artifact identity before execution.

Removing `dice-check` from the registry yields explicit `MISSING_PLUGIN`; incompatible version/capability/schema also blocks preflight.

## No Core rewrite proof — PASS

- `packages/core/src` contains no `dice-check` ID or dice-specific action identity;
- Core imports no plugin package;
- d20 arithmetic and success/failure branching live entirely in trusted plugin code;
- the plugin returns canonical effects which existing Core validates/applies;
- no `if pluginId === 'dice-check'` or equivalent dispatch was introduced.

This satisfies canonical §12.4.

## Generated build truth — PASS

The deterministic agent contract now reflects the concrete build:

- installed plugin count = 1;
- `dice-check@1.0.0` is listed;
- capability, schema version, block/action/recipe metadata are exposed;
- plugin registry hash changes with the installed plugin;
- no public generic plugin HTTP endpoint is advertised because none exists.

## Scope boundaries — accepted, not blockers

B08 does not promise or implement:

- untrusted third-party JavaScript sandbox/marketplace;
- arbitrary remote/dynamic plugin loading;
- custom `WorldState.extensions[pluginId]` reducers;
- a generic public Runtime plugin endpoint;
- a complete Studio plugin editor or custom result widget;
- production auth/publish persistence/enforcement of plugin sidecars.

The last item belongs to B09: B08 provides immutable sidecar/preflight contracts so B09 can wire them into real publish/start authority without changing Core or old `QuestRelease`/`FrozenPlaytestRecord` v1.

## Verdict

Canonical B08 unresolved **BLOCKER = 0**.

B08 is functionally complete at code/contract level. B08-03 must still pass the normal Publication Gate (docs/current-head CI → ready → pinned merge → exact merge-SHA main push CI) before B08 may be called published.
