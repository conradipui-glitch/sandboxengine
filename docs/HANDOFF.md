# Передача работы

Обновлено: 2026-09-07

Текущий блок: **B08-01 — trusted plugin manifest / deterministic registry**  
База: published canonical B07 merge `1889145e1784e9186d0914207168448c111b8114`  
B07 main CI: `34102992250` — success  
Ветка: `b08-01-plugin-manifest-registry`  
PR: #28  
Статус: **functional accepted; plugin-aware CI `34105282304` success на `adee3d4b2328d5fad5f56df9a347450d875fb496`; semantic audit BLOCKER=0; docs/current-head Publication Gate next**

## Published foundation

B01–B06 published.  
Canonical B07 fully published: presentation contracts, immutable assets, Player executor and Runtime/browser integration.

B07 publication evidence: merge `1889145e1784e9186d0914207168448c111b8114`, exact main push CI `34102992250` success.

## B08-01 implementation

`@living-history/plugins` is a pure data/registry package. It does not execute plugin code.

Authority rule:

`trusted build manifests -> deterministic frozen registry -> pure release compatibility decision`

No plugin descriptor receives mutable WorldState, database, HTTP response, filesystem/network/process access or arbitrary executable source.

### Manifest

- Draft 2020-12 canonical schema version `1.0`;
- engine plugin API version `1.0.0`;
- exact data-only shape;
- namespaced block/action/event/effect/capability/recipe/schema/UI IDs;
- separate backend and UI metadata;
- no import URL, JS source, raw HTML or callback fields.

### Registry

- validates all manifests before use;
- duplicate plugin ID fails;
- missing/mismatched dependencies fail;
- dependency cycles fail;
- cross-plugin owned-ID collisions fail;
- dependency-first topological order is deterministic with lexical tie-break;
- result is deeply frozen.

### Release compatibility

Pure checker reports missing/incompatible plugin version, capability or schema. It never silently ignores a required plugin at this layer.

### Generated agent contract

`docs:generate` now exposes:

- plugin manifest schema `1.0`;
- engine plugin API `1.0.0`;
- actually installed trusted plugin metadata/capability IDs;
- separate deterministic plugin registry hash.

Current `packages/plugins/registry/installed.json` contains **zero plugins**. This is intentional: resolver execution and `dice-check` do not exist yet and are not advertised.

## Evidence

- implementation `f4ea4bca1f5fb170db81b456cf9c29de7abf00dd` → CI `34103718389` exposed only TS empty-tuple typing issue;
- type fix `3bd15d318de0c94e5038a1af3f44148de794bfe0` → CI `34104110358` success;
- schema/docs hardening `adee3d4b2328d5fad5f56df9a347450d875fb496` → CI `34105282304` success;
- semantic audit: `docs/audits/2026-09-07-b08-01-semantic-audit.md` → unresolved BLOCKER **0**.

ADR: `docs/decisions/0026-trusted-plugin-manifest-registry.md`.  
Worklog: `docs/worklog/2026-09-07-b08-01.md`.

## Honest scope boundary

Not implemented in B08-01:

- resolver / scheduled-event / custom-effect execution;
- Runtime plugin command integration;
- Studio-generated plugin forms;
- UI plugin rendering;
- `dice-check`;
- third-party sandbox/marketplace;
- Runtime/publish enforcement of release plugin requirements.

## Publication Gate

1. final full CI on exact docs/current head;
2. update PR #28 body with final evidence;
3. mark PR #28 ready;
4. merge pinned to exact expected head;
5. verify exact merge-SHA push-to-main CI;
6. only then call B08-01 published.

## Next

After verified B08-01 publication: **B08-02 — trusted backend plugin execution contracts** exactly from the verified B08-01 merge SHA.

Do not start B08-02 before that publication check.
