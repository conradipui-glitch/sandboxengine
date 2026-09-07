# B08-01 — trusted plugin manifest, compatibility and dependency registry

## Goal

Introduce the first canonical plugin/extension boundary without executing plugin gameplay code yet.

Base: published canonical B07 merge `1889145e1784e9186d0914207168448c111b8114`, main CI `34102992250` — success.

Specification source: §12 “Расширения без переписывания ядра”.

## Main invariant

**A plugin registry may describe and validate trusted build-time capabilities, but it must not become a dynamic code-loading surface or gameplay authority. No arbitrary URL/import/eval/HTML execution is introduced.**

## Do

### 1. Canonical manifest contract

Define a versioned plugin manifest containing at minimum:

- `pluginId`;
- plugin version;
- supported engine/plugin API version range;
- versions of plugin-owned schemas;
- explicit plugin dependencies;
- capability IDs;
- human description;
- recipe/template IDs;
- separate backend/UI declarations.

Requirements:

- all plugin-owned public IDs are namespaced by `pluginId`;
- exact bounded string/list sizes;
- duplicate IDs inside one manifest fail;
- manifest is pure data and serializable;
- no filesystem path, import URL, source code, HTML, callback or executable field exists in the manifest.

### 2. Startup registry

Add a deterministic registry that is fully built before quest/release loading.

It must:

- register trusted in-process plugin descriptors supplied by the application build;
- validate manifest compatibility against one explicit engine plugin-API version;
- reject duplicate `pluginId`;
- reject duplicate globally registered action/block/event/effect/capability/UI IDs;
- resolve dependencies explicitly;
- reject missing dependencies;
- reject dependency version mismatch;
- reject cycles;
- produce one deterministic topological order independent of import/insertion order where the dependency graph leaves the order unconstrained (stable lexical tie-break is acceptable);
- freeze the resulting registry snapshot after construction.

Do not add `beforeAnything` / `afterAnything` global hooks.

### 3. Capability descriptors only

B08-01 may register descriptors for future categories:

- block type IDs + schema version IDs;
- action type IDs;
- scheduled event type IDs;
- namespaced effect type IDs;
- recipe/template IDs;
- trusted UI component IDs + props schema IDs.

These are identifiers/metadata only in this slice. No resolver/effect/UI function execution yet.

### 4. Release compatibility check

Add a pure validator that receives the frozen installed registry and a quest/release requirement set and reports:

- compatible;
- missing plugin;
- incompatible plugin version/API version;
- missing required capability/schema version.

A release requiring an unavailable plugin must fail explicitly. It must never silently skip plugin-owned blocks/actions/effects.

Do not yet wire this into publication/Runtime start; that integration belongs to the next bounded slice after the registry contract is proven.

### 5. Trust / executable-code boundary

Add boundary tests/checks proving:

- registry code contains no dynamic `import()` of manifest-provided values;
- no `eval` / `new Function`;
- no plugin URL/source/HTML handler field;
- no direct DB/HTTP/process.env API is exposed by the registry contract;
- UI descriptor is a pre-registered component ID, not an import URL or raw HTML;
- registry has no Core mutation callback.

### 6. Agent/docs registry

Extend generated capabilities/compatibility documentation only with capabilities that are truly implemented in B08-01:

- plugin manifest schema/version;
- installed trusted plugin metadata / capability identifiers;
- engine plugin-API version.

Do not advertise backend resolver execution or dice-check until implemented.

## Tests

Minimum deterministic regressions:

1. valid zero-plugin registry;
2. valid single plugin;
3. dependency chain sorts correctly;
4. insertion order does not change frozen registry output;
5. missing dependency rejected;
6. dependency version mismatch rejected;
7. cycle rejected;
8. duplicate plugin ID rejected;
9. cross-plugin capability/action/block/effect/UI ID collision rejected;
10. non-namespaced plugin-owned ID rejected;
11. executable/import URL/raw HTML/source field rejected by exact manifest shape;
12. incompatible engine plugin-API range rejected;
13. release compatibility fails when required plugin/capability/schema is absent or incompatible;
14. registry snapshot is deeply frozen;
15. root `npm run verify` and boundary/docs checks green.

## Functional acceptance

B08-01 is accepted when:

1. manifest and registry are canonical, deterministic and versioned;
2. dependency/compatibility failures are explicit and fail closed;
3. the registry cannot dynamically load or execute untrusted code;
4. no Core/Runtime gameplay authority has been added to plugin descriptors;
5. release requirements can be checked purely against the installed frozen registry;
6. generated agent docs reflect only the implemented registry surface;
7. semantic audit has zero unresolved BLOCKER.

## Not now

- backend resolver execution;
- scheduled-event handler execution;
- plugin-owned effect reducers;
- Studio auto-generated plugin forms;
- runtime typed plugin commands;
- UI component rendering;
- dice-check proof plugin;
- third-party marketplace/sandbox;
- B09 auth/publish.

## Expected next slices

- **B08-02** — backend plugin execution contract: read-only state + validated args + deterministic clock/RNG -> typed ActionPlan/effects; scheduled-event/effect namespace rules.
- **B08-03** — `dice-check` proof plugin + Studio schema/recipe + minimal optional UI indicator; prove no `if pluginId === "dice-check"` in Core and incompatible release fails closed.

Create later slices only from verified published predecessors.
