# B08-01 semantic audit — plugin manifest / registry foundation

Date: 2026-09-07

Scope: PR #28, branch `b08-01-plugin-manifest-registry`.

Base: published canonical B07 merge `1889145e1784e9186d0914207168448c111b8114`, exact main CI `34102992250` success.

## Acceptance findings

### Manifest boundary — PASS

- canonical Draft 2020-12 plugin manifest schema exists;
- runtime validator and JSON Schema agree on the accepted data shape;
- plugin-owned IDs are namespaced and bounded;
- duplicate owned IDs fail closed;
- executable/source/import URL/raw HTML widening is rejected by exact shape;
- backend/UI declarations are identifiers/metadata only.

### Registry determinism — PASS

- zero/single/multi-plugin registries are deterministic and deeply frozen;
- dependencies are checked explicitly before use;
- missing/mismatched dependencies and cycles fail closed;
- dependency-first topological order uses deterministic lexical tie-break;
- duplicate plugin IDs and cross-plugin owned-ID collisions fail closed.

### Compatibility — PASS

- engine API ranges use deterministic explicit bounds;
- release requirements report missing/incompatible plugin, capability and schema cases;
- no plugin-required release path silently skips an unavailable capability at this layer.

### Authority / security boundary — PASS

- `@living-history/plugins` has no Core/Runtime/Control/Player/AI imports;
- no dynamic plugin import, `eval`, `new Function`, fetch/network/process/filesystem authority;
- no database handle, HTTP response, mutable WorldState or global before/after hook is exposed;
- B08-01 executes no resolver, scheduled-event handler, effect reducer or UI component.

### Agent contract — PASS

Generated docs expose only implemented registry metadata:

- plugin manifest schema version `1.0`;
- engine plugin API version `1.0.0`;
- installed plugins: `[]`;
- installed plugin capability IDs: `[]`;
- separate deterministic plugin registry hash.

They do **not** advertise backend resolver execution or `dice-check`.

## CI evidence

- initial implementation `f4ea4bca1f5fb170db81b456cf9c29de7abf00dd` reached CI `34103718389`; only defect was TypeScript empty-tuple typing;
- type-fix head `3bd15d318de0c94e5038a1af3f44148de794bfe0` → CI `34104110358` success;
- plugin-schema/generated-doc hardening head `adee3d4b2328d5fad5f56df9a347450d875fb496` → CI `34105282304` success, including `docs:check` and boundary checks.

## Follow-up, not blockers

- B08-01 does not execute plugin code; B08-02 owns typed resolver/event/effect execution contracts.
- Build-installed registry currently has zero plugins; B08-03 owns the `dice-check` proof plugin.
- Runtime/publish enforcement of release plugin requirements is not wired in this slice.
- A `PluginRegistrySnapshot` is trusted startup state, not a user-deserialized public object; public requirement input remains validated.

## Verdict

Unresolved **BLOCKER = 0**.

B08-01 is functionally accepted and may proceed to the standard Publication Gate: docs/current-head CI → ready → pinned merge → exact merge-SHA main push CI.
