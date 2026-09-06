# Canonical JSON Schemas — v1

`packages/contracts/schemas/v1/` is the source of truth for the current contract DTO layer. All schemas use JSON Schema Draft 2020-12 and carry a stable `$id`; every data object carries `schemaVersion: "1.0"`.

Current bounded schemas:

- runtime boundary: `Effect`, `ActionResult`, minimal `WorldState`, `SceneFrame`, `PresentationPlan`;
- authoring boundary: `Block`, minimal `QuestRelease`, `ResolvedIntent`.

Rules for this version:

1. Unknown object fields are rejected with `additionalProperties: false` unless the field is explicitly an extensible JSON argument bag such as `ResolvedIntent.args`.
2. A different `schemaVersion` is incompatible; it is not coerced to 1.0.
3. IDs are opaque stable technical keys. Display titles may change without changing IDs.
4. JSON Schema validates data shape and local constraints. Cross-object membership such as `entity.locationId`, `QuestRelease.blockIds`, character start locations, or `dialogue.show.lineId` is semantic validation and is checked separately.
5. Breaking changes require a new schema version and `$id`; do not silently widen v1.0. Additive fields also require an explicit compatibility decision because unknown fields are rejected by this version.
6. The current PresentationPlan schema includes only node shapes whose arguments are concretely specified by the first cross-cutting fixture (`sequence`, `parallel`, `actor.show`, `item.show`, `dialogue.show`). Other commands named in the product specification are not advertised as implemented contracts yet.
7. The current WorldState is intentionally minimal. Tasks, scheduled events, knowledge, RNG and extensions enter later bounded slices when their exact contracts are implemented.
8. The current Block registry is intentionally minimal: `core.location`, `core.character`, `core.resource`. Other block kinds from the product specification remain planned until a bounded schema defines their `data` contract.
9. `ResolvedIntent` describes understood input only. It cannot contain duration, effects or state mutation; those belong to later Core resolution.
10. `QuestRelease` in B01-03 is the minimal immutable reference manifest needed for the following compile slice. Content hashes, plugin locks and asset manifests are not fabricated before their compiler contract exists.

TypeScript exports in `src/` mirror these schemas for consumers. Contract tests validate canonical fixtures through Ajv. `ActionResult` additionally has a public runtime guard whose checked examples are compared with its JSON Schema; generated TypeScript/documentation remains a later B01 slice.
