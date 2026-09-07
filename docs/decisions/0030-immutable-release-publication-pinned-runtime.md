# ADR 0030 — immutable release publication and pinned Runtime bootstrap

Status: Accepted

Date: 2026-09-07

## Context

B09-01 established authenticated Control users, sessions and project roles, but a validated authoring draft still was not a production release. Runtime production composition still needed a durable, restart-safe way to start only from explicitly published immutable content while keeping already-created sessions pinned to the exact release they started with.

The boundary must preserve earlier invariants:

- Core owns gameplay truth, not publication metadata;
- Runtime must not depend on Control;
- B08 plugin compatibility is the one compatibility system;
- changing a current release pointer must not mutate immutable release content or existing session state;
- missing/corrupt/incompatible release data must fail closed rather than fall back to current draft, another release, another plugin version or a static production template.

## Decision

### 1. Release is an immutable Control envelope around a canonical compiled artifact

Control persists an immutable `ControlReleaseRecord` containing:

- project/quest/release identity;
- exact source draft revision and content hash;
- exact successful validation identity;
- canonical compiled artifact;
- recomputed SHA-256 compiled artifact hash;
- explicit B08 plugin requirements sidecar, including an explicit empty sidecar when no plugin is required;
- exact supported authored plugin sidecars bound to the same compiled artifact hash.

A release ID is append-only identity. Existing release content is never rewritten by publish or rollback.

### 2. Build re-proves exact validation and plugin compatibility

Release build accepts only an exact successful validation for the same project, quest, draft revision and draft content hash. The compiled artifact hash is recomputed before persistence. B08 plugin requirements and supported authored sidecars are validated against the installed trusted plugin registry before the release is stored.

Build is idempotent and available to project owner/editor; tester has read/test authority only.

### 3. Publish and rollback move only a durable current pointer

Each quest has a nullable durable `currentReleaseId` plus append-only publication events.

Publish and rollback are owner-only, idempotent compare-and-set operations. Immediately before pointer movement they re-run stored release integrity/plugin preflight. Rollback may target only a release that has previously appeared as a successful publication target.

No publication operation mutates Runtime sessions or world state.

### 4. Runtime production composition resolves published content at the application boundary

`@living-history/runtime` remains independent from `@living-history/control`.

The server/application layer composes:

`ControlReleaseStore + installed PluginRegistry -> PublishedReleaseResolver -> Runtime session creation`

A new published session resolves the quest's current pointer, re-preflights the exact stored release, derives a frozen initial `WorldState` and execution context from that exact artifact, then persists the Runtime session with its exact `PinnedReleaseIdentity`.

The durable application-owned `PublishedSessionBindingStore` stores the Control project scope needed to resolve an existing Runtime session without widening the Runtime session schema.

### 5. Existing sessions resolve by pinned identity, never by current pointer

Every action for a published session re-resolves its execution context using the durable project binding plus the session's exact pinned `questId + releaseId + contentHash`.

Therefore:

- publishing v2 affects only sessions created after v2 becomes current;
- rollback affects only sessions created after rollback;
- v1 sessions continue using v1 after v2 publication;
- v2 sessions continue using v2 after rollback to v1;
- restart reopens release storage, binding storage and Runtime storage and preserves the same behavior.

### 6. Static templates are explicit test/dev mode only

The Runtime server supports either static templates or published-release resolution, never both in one composition. Production `main.ts` uses SQLite release storage + published session bindings and does not silently install `minimal-paint` as fallback.

### 7. Current action routing is deliberately narrow and fail-closed

The B09-02 published resolver accepts the currently implemented unambiguous single `core.action` routing case. Artifacts requiring ambiguous multi-action routing fail with `UNSUPPORTED_ACTION_ROUTING`; no action is guessed. Widening this requires an explicit later contract/routing design rather than implicit ordering.

## Consequences

- Publication is auditable and restart-safe without changing Core contracts.
- Release compatibility is re-proved at build, publish/rollback and new-session start.
- Existing saves are protected from current-pointer movement.
- Runtime guest authentication remains separate from Control owner authentication.
- Missing/incompatible/corrupt published content blocks new starts explicitly.
- Future B09-03 version UX can consume the durable release/history contract without becoming gameplay authority.
- Future richer action routing must preserve exact release pinning and fail-closed semantics.

## Rejected alternatives

- Treat current draft as production content: rejected because validation/publication identity would be mutable.
- Rewrite a release on republish: rejected because release identity would stop being immutable/auditable.
- Resolve every action from `currentReleaseId`: rejected because existing sessions would silently migrate mechanics.
- Put Control release lookup inside `@living-history/runtime`: rejected because it violates package authority boundaries.
- Fall back to another release/static template when current release is unavailable: rejected because it hides deployment/integrity failure.
- Duplicate plugin compatibility rules in Control/Runtime: rejected; B08 preflight remains canonical.
