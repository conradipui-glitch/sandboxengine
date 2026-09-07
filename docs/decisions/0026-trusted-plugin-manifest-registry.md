# ADR 0026 — trusted plugin manifest and deterministic startup registry

Status: Accepted

Date: 2026-09-07

## Context

B08 must prove that the engine can be extended without adding plugin-specific conditionals to Core and without creating a remote-code marketplace. The specification requires trusted build-time code, namespaced capability IDs, explicit dependencies and fail-closed compatibility checks.

## Decision

Introduce `@living-history/plugins` as a pure registry/contract package. B08-01 does **not** execute plugin resolver, event, effect or UI callbacks.

The canonical manifest is data-only and versioned (`plugin manifest schema 1.0`). It declares `pluginId`, plugin version, engine plugin API range, schema versions, dependencies, capabilities, recipe IDs and separate backend/UI identifiers. Exact manifest shape rejects source code, import URLs, raw HTML and arbitrary executable fields.

The engine plugin API starts at `1.0.0`. Version compatibility uses explicit `{minInclusive,maxExclusive}` triples rather than npm semver strings so registry behavior does not depend on package-manager parsing semantics.

Startup registry construction is deterministic and fail-closed:

- validate every manifest before registration;
- reject duplicate plugin IDs and globally colliding owned IDs;
- validate dependency existence and version ranges;
- reject dependency cycles;
- produce dependency-first topological order with lexical tie-break;
- deep-freeze the resulting snapshot.

Release compatibility is a pure check against that trusted frozen registry. A missing plugin/capability/schema is an explicit incompatibility, never a silent skip.

`packages/plugins/registry/installed.json` is build metadata for what this concrete build actually contains. In B08-01 it intentionally contains zero installed plugins. Generated agent docs expose the manifest/API versions and this empty installed set, but do not advertise resolver execution or `dice-check`.

## Trust boundary

Code plugins remain trusted code included by the application build. TypeScript types are not a sandbox. B08-01 introduces no URL import, `eval`, `new Function`, plugin HTTP/network access, `process.env`, filesystem loading, database access or gameplay mutation callbacks.

`PluginRegistrySnapshot` is an internal trusted object created during startup, not a public deserialization boundary. Public release requirements are validated against the installed registry; callers are not expected to deserialize arbitrary registry snapshots from users.

## Consequences

- B08-02 can add typed backend execution contracts without revisiting discovery/dependency semantics.
- B08-03 can add `dice-check` as the proof plugin and must update installed registry/docs only when that plugin really exists in the build.
- Removing an installed plugin can be detected by release compatibility before Runtime/start/publish integration is wired.
- No promise of third-party sandbox or marketplace security is made.
