# B11-02 — sandbox adapter and new-session runtime pinning

Status: **GREEN — routing/pinning gate closed; semantic Florence runtime remains B11.3**

Depends on: B11.0 source mapping, B11.1 real quest packages.

## Exact integration source

- application repo: `conradipui-glitch/sandbox`
- base: `f9b0cd0d607da48d89827f0a1a882b74e9b78e50`
- branch: `b11-engine-runtime-routing`
- draft PR: `conradipui-glitch/sandbox#10`
- verified head: `9b4c2402d38e32edaccfb9208121332df172a559`
- verify workflow run: `34228303098`
- job result: `npm ci` / `npm test` / `npm run build` all success
- no deployment is performed by the verify workflow

Do not treat later movement of the sandbox branch as evidence for this gate without a new exact-head run.

## Boundary implemented in sandbox

B11.2 deliberately does not modify the legacy `HistorySession` storage format.

The integration adds:

1. a wrapper Worker entrypoint around the existing legacy worker;
2. `RuntimeRouteSession`, a separate Durable Object containing one immutable Engine route binding;
3. `ENGINE_FLORENCE_ROLLOUT=off|test|on` selection for **new Florence session creation only**;
4. `test` mode requiring explicit `runtime: "engine"`, so the existing client remains on legacy by default;
5. pinned upstream Engine base URL, Engine session id and credential for a selected public sandbox session id;
6. fail-closed Engine creation when the configured Engine/published quest is unavailable;
7. a rollback runbook at `sandbox/docs/b11-engine-rollout.md`.

## Proven session rule

The automated BFF test proves this sequence:

1. create a Florence session while rollout is `test` and explicit Engine routing is requested;
2. persist the Engine route binding;
3. change the global rollout flag to `off`;
4. GET the same public session id and still reach the pinned Engine session;
5. GET an unrelated legacy id with no route binding and fall through to the old worker.

Therefore the global flag is not consulted on every turn and cannot silently migrate an existing session.

## Legacy-save safety

Old sessions have no `RuntimeRouteSession` binding and remain in `HistorySession` under the existing `StoredGame` record. B11.2 performs no conversion, copy, deletion or mutation of those saves.

Rollback is selection-only: set the rollout flag to `off` for future sessions and retain both the legacy Durable Objects and any already-created Engine route bindings.

## Intentional B11.2 limit

This gate proves routing and persistence ownership only.

The current Engine HTTP action boundary still exposes the earlier `core.paint` action path. `examples/florence/narrative-beats.json` is validated data, but those authored options are not yet executable through published Runtime HTTP. Consequently:

- B11.2 does **not** claim T27;
- `ENGINE_FLORENCE_ROLLOUT=on` remains forbidden;
- the Engine BFF returns an explicit test envelope rather than pretending to be legacy `GameState`;
- Engine metrics facade is still outside this slice.

## B11.3 next gate

Add a quest-agnostic authored-option runtime boundary that can execute the migrated beats through generic Core effects and explicit clock semantics, then prove:

- canonical Florence route;
- paid-compromise route;
- refusal/preserve-authorship route;
- conditional vs executed vs blocked semantics;
- idempotent retry;
- terminal outcomes;
- old/new semantic comparison;
- client/BFF compatibility sufficient for a test route.

No Florence actor, resource or scenario identifiers may enter `packages/core`.
