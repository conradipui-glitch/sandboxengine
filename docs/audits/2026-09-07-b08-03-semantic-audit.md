# B08-03 semantic audit — dice-check extensibility proof

Date: 2026-09-07

Scope: PR #30, branch `b08-03-dice-check-proof-plugin`.

Base: published B08-02 merge `a3eef28d106d89bdc4e05cf5c9fd7c1eb61e97e1`, exact main CI `34108753710` success.

## Acceptance findings

### Real installed plugin — PASS

- build-installed registry contains exactly `dice-check@1.0.0` for this proof build;
- installed JSON metadata is validated and regression-tested against the actual `DICE_CHECK_MANIFEST` constant;
- capability/action/schema/recipe IDs are namespaced and agree across manifest, JSON Schema, Studio form metadata and recipe;
- generated agent docs advertise the installed plugin, capability, block/action and recipe metadata and a changed plugin registry hash.

### Authored mechanic / player authority — PASS

- plugin-owned definition schema and runtime validator bound difficulty `1..40`, modifier `-20..20`, duration and bounded success/failure effect/narrative fields;
- action args are exact and contain only `definitionId`;
- player input cannot inject difficulty, modifier, duration, narrative or effects;
- effect templates instantiate only published canonical `resource.change`, `entity.move` and `item.transfer` effects;
- invalid authored effects still fail atomically at the existing Core effect gate.

### Deterministic execution — PASS

- resolver draws exactly one d20 value through the B08-02 host RNG capability;
- total/outcome are derived only from that provenance plus authored modifier/difficulty;
- same authored definition/state/args/seed produces byte-equivalent validated plan, RNG provenance, projected result and Core candidate state;
- success/failure selects only the authored branch;
- narrative projection uses allowlisted text placeholders and rejects HTML/unknown placeholders;
- duration advances only through the existing Core time path.

### Frozen-artifact binding — PASS after hardening

Initial post-green semantic audit found one real blocker: requirements were bound to `artifactHash`, but `DiceCheckDefinition[]` could still be supplied independently to the executable registration. That meant a frozen artifact could theoretically execute a different authored difficulty/effect set without changing its artifact identity.

Hardening added `DiceCheckAuthoredSidecar` and `bindDiceCheckRegistrationToArtifact`:

- validated definitions are detached and deeply frozen into a versioned sidecar;
- the sidecar carries the exact compiled/frozen artifact hash;
- hash mismatch fails before an executable registration exists;
- definitions are revalidated/cloned when materializing the registration;
- mutation of the pre-freeze draft object cannot alter the sidecar/registration;
- server proof executes the artifact-bound registration through the generic B08-02 host and Core.

The separate generic `PluginArtifactRequirementsSidecar` continues to prove installed compatibility and returns `MISSING_PLUGIN` when `dice-check` is absent.

### Core / architecture boundary — PASS

- regression scans `packages/core/src` and forbids `dice-check` identity/imports;
- Core remains generic and contains no dice arithmetic or plugin-specific dispatch;
- plugin package remains covered by B08-02 no-Core/no-DB/no-network/no-process/dynamic-code and obvious nondeterminism guards;
- no custom `WorldState` reducer, arbitrary code loading or public plugin HTTP endpoint was added.

## CI evidence

- first implementation `acdce4946193a67407723a49c9ca6cada7226d13` → CI `34109914329` exposed only four primary TypeScript defects in the new plugin file;
- type fix `d913d7b38676b00a1f209ef31e0be21c11a5a0d6` → CI `34110050259`; all functional suites/boundary checks passed and only generated agent docs were stale;
- generated-doc sync/head `8c23a3358e5783ee2b4d998d6ae525d478b0f7d2` → CI `34112482535` success including `docs:check`;
- post-green artifact-binding hardening head `339b01b99ea70d8e2b9db958384d95be66598f8b` → CI `34112797727` success.

## Follow-up, not blockers

- B08 does not add a public generic Runtime plugin action endpoint; the proof executes through the internal generic host.
- B09 owns production persistence/enforcement of plugin sidecars in publish/start flows.
- Current Studio proof is schema/form metadata, not a complete plugin editor redesign.
- Text result is mandatory and implemented; no custom result widget is required for B08.
- Custom namespaced `WorldState` extensions/reducers remain unsupported until a separately versioned contract exists.
- Trusted build plugins are not an untrusted-code sandbox or marketplace.

## Verdict

Unresolved **BLOCKER = 0**.

B08-03 is functionally accepted and may proceed to the canonical B08 audit and standard Publication Gate.
