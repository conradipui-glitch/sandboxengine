# Contract fixtures

Fixtures are executable examples for the canonical schemas in `../schemas/v1/`. They intentionally cover only fields declared by the currently accepted B01 slices.

## Runtime-boundary examples

Valid:
- `effect.valid.json`
- `action-result.executed.json`
- `world-state.valid.json`
- `scene-frame.valid.json`
- `presentation-plan.valid.json`

Rejected by schema:
- `effect.invalid-type.json`
- `action-result.invalid.json`
- `world-state.invalid-version.json`
- `scene-frame.invalid-type.json`
- `presentation-plan.invalid-type.json`

`world-state.invalid-reference.json` and `presentation-plan.invalid-reference.json` are deliberately JSON-Schema-valid and rejected by semantic reference checks.

## Authoring examples

`minimal-quest/` is one coherent package fixture:
- `quest-release.json`
- `blocks/workshop.json`
- `blocks/painter.json`
- `blocks/blue-paint.json`

`resolved-intent.valid.json` is a separate understanding-layer example; it does not claim the action has already executed.

Negative fixtures:
- `block.unknown-kind.json` — kind not registered by the current block schema;
- `block.duplicate-id.json` — individually shape-valid, but invalid when combined with another block using the same ID;
- `quest-release.invalid-version.json` — incompatible schema version;
- `quest-release.invalid-reference.json` — shape-valid release referencing a missing block;
- `resolved-intent.invalid-mutation.json` — tries to smuggle duration and a state patch into the understanding result.

The semantic fixtures demonstrate an intentional boundary: JSON Schema validates local shape; package/reference integrity is a separate deterministic check.
