# Canonical JSON Schemas — v1

`packages/contracts/schemas/v1/` is the source of truth for the B01-02 DTO layer.
All schemas use JSON Schema Draft 2020-12 and carry a stable `$id`; every data
object carries `schemaVersion: "1.0"`.

Rules for this version:

1. Unknown object fields are rejected with `additionalProperties: false`.
2. A different `schemaVersion` is incompatible; it is not coerced to 1.0.
3. IDs are opaque non-empty strings. Renaming display text must not change IDs.
4. JSON Schema validates structure and local constraints. Cross-object membership
   such as `entity.locationId` existing in `WorldState.locations`, or a
   `dialogue.show.lineId` existing in `SceneFrame.dialogue`, is a semantic
   reference check and is validated separately.
5. Breaking changes require a new schema version and `$id`; do not silently widen
   v1.0. Additive fields also require an explicit compatibility decision because
   unknown fields are rejected by this version.
6. The current PresentationPlan schema includes only node shapes whose arguments
   are concretely specified by the first cross-cutting fixture (`sequence`,
   `parallel`, `actor.show`, `item.show`, `dialogue.show`). Other commands named
   in the product specification are not advertised as implemented contracts yet.
7. The current WorldState is intentionally minimal. Tasks, scheduled events,
   knowledge, RNG and extensions enter later bounded slices when their exact
   contracts are implemented.

TypeScript exports in `src/` mirror these schemas for consumers. Contract tests
validate the same fixtures through Ajv and, for `ActionResult`, through the
public TypeScript runtime guard to detect drift.
