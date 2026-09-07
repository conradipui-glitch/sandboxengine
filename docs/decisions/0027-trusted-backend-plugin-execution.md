# ADR 0027 — trusted backend plugin execution through Core authority

Status: Accepted

Date: 2026-09-07

## Context

B08-01 established a deterministic trusted plugin manifest/registry but intentionally executed no plugin code. B08-02 must add executable backend extension points without adding plugin-specific branches to Core, without letting a plugin return authoritative state, and without creating a second effect/time/scheduler implementation.

The current canonical `WorldState` v1 has no `extensions[pluginId]` namespace. Therefore custom plugin state reducers cannot be introduced honestly in this slice.

## Decision

Add trusted build-time backend registrations separately from the serializable plugin manifest. Registrations may provide manifest-declared action resolvers and scheduled-event handlers. They are application code, not release data and not remotely loaded code.

### Resolver capability boundary

A resolver receives only:

- a detached deeply frozen `WorldState` snapshot;
- validated/frozen JSON arguments;
- simulation `elapsedSeconds`;
- immutable plugin/action identity;
- a bounded deterministic `drawInt()` capability supplied by the host.

It does not receive a Runtime store, transaction/commit callback, HTTP object, database handle, mutable state, unrestricted Core module, filesystem/network/process capability through the plugin API, or presentation authority.

Resolver output is one exact bounded `PluginActionPlan` containing action outcome metadata, canonical `GameplayEffect[]`, canonical `SchedulerEvent[]`, duration and no candidate state/state patch/callback/executable field. Host-owned RNG provenance is attached after resolver return.

### Core remains gameplay authority

The server adapter owns deterministic RNG state and applies a validated plan only through existing Core primitives:

`plugin resolver -> validated PluginActionPlan -> tryApplyEffectBatch -> planTimeAdvance/applyTimeAdvancePlan`

A plugin never returns or commits `WorldState` directly. Invalid canonical effects fail at the same Core invariant gate used by built-in gameplay.

### Scheduler handlers

Plugin scheduled-event handlers return only bounded canonical child `SchedulerEvent[]`. They are routed through the existing `processTimeAdvancePlan` handler boundary. Core remains responsible for generated-event shape, duplicate IDs, past events, effective ordering, event/step budgets and the final atomic transition.

RNG advancement is returned only with a successful host/Core result. Failures expose no advanced RNG state.

### Custom effects

Manifest-declared namespaced custom effect IDs remain metadata only in B08-02. Since `WorldState` v1 has no plugin extension namespace, execution accepts only existing canonical gameplay effects. A custom/non-canonical effect fails closed until a separately versioned state-extension/reducer contract exists.

### Trust model and static guards

Plugins remain trusted in-process application code, not sandboxed third-party code. The repository boundary checker enforces the canonical plugin package direction:

- Plugins cannot import Core/Runtime/Control/Player/AI/Assets or app modules;
- Plugins cannot import filesystem/network/process/database/dynamic-code surfaces covered by the guard;
- obvious wall-clock/entropy shortcuts (`Math.random`, `Date.now`, `performance.now`) are rejected in canonical plugin sources;
- Core cannot import `@living-history/plugins`.

This is a build-time architecture guard, not a security claim that arbitrary untrusted JavaScript can be safely executed in-process.

## Consequences

- B08-03 can prove extensibility with a concrete `dice-check` plugin using the generic registry/host without `if pluginId === ...` in Core.
- `resource.change`, time and scheduler behavior remain one canonical Core implementation.
- Failed plugin resolution/effect/scheduler transitions do not publish candidate state or advanced RNG state.
- Custom plugin state reducers remain unavailable until the engine versions a dedicated state-extension contract.
- No public Runtime plugin endpoint, marketplace or third-party sandbox is introduced by B08-02.
