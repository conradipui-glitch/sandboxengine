# Canonical JSON Schemas — v1

`packages/contracts/schemas/v1/` is the source of truth for the core contract DTO layer introduced in B01. All schemas use JSON Schema Draft 2020-12 and carry a stable `$id`; every v1 data object carries `schemaVersion: "1.0"`.

Current bounded schemas:

- runtime/core boundary: `Effect`, `ActionResult`, minimal `WorldState` and other v1 gameplay contracts;
- authoring boundary: `Block`, minimal `QuestRelease`, `ResolvedIntent`;
- **legacy presentation subset:** `SceneFrame` and `PresentationPlan` v1 remain readable and frozen for backward compatibility, but B07 clients should use the complete presentation v2 contracts in `../v2/`.

Rules for this version:

1. Unknown object fields are rejected with `additionalProperties: false` unless the field is explicitly an extensible JSON argument bag such as `ResolvedIntent.args`.
2. A different `schemaVersion` is incompatible; it is not coerced to 1.0.
3. IDs are opaque stable technical keys. Display titles may change without changing IDs.
4. JSON Schema validates data shape and local constraints. Cross-object membership such as `entity.locationId`, `QuestRelease.blockIds`, character start locations, or `dialogue.show.lineId` is semantic validation and is checked separately.
5. Breaking changes require a new schema version and `$id`; do not silently widen v1.0. Additive fields also require an explicit compatibility decision because unknown fields are rejected by this version.
6. Presentation v1 intentionally remains the original B01 subset (`sequence`, `parallel`, `actor.show`, `item.show`, `dialogue.show`). B07 does **not** mutate it in place; the complete command set and immutable asset references live in presentation schema v2.
7. The current WorldState is intentionally minimal. Tasks, scheduled events, knowledge, RNG and extensions enter later bounded slices when their exact contracts are implemented.
8. The current Block registry is intentionally minimal and grows only through bounded schema changes.
9. `ResolvedIntent` describes understood input only. It cannot contain duration, effects or state mutation; those belong to Core resolution.
10. `QuestRelease` in v1 is the immutable reference manifest used by the current authoring/runtime slices. Presentation asset ingestion/storage is implemented separately from the legacy presentation schema.

TypeScript exports in `src/` mirror these schemas for consumers. Contract tests validate canonical fixtures through Ajv. Legacy presentation v1 stays available under the existing TypeScript names; B07 presentation v2 uses explicit `*V2` exports until a future deprecation/migration policy says otherwise.
