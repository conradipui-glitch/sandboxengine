# Contract fixtures

Fixtures are executable examples for the canonical schemas in `../schemas/v1/`.
They intentionally cover only fields declared by B01-02.

## Valid examples

- `effect.valid.json`
- `action-result.executed.json`
- `world-state.valid.json`
- `scene-frame.valid.json`
- `presentation-plan.valid.json`

## Rejected examples

- `effect.invalid-type.json` — effect type is not namespaced.
- `action-result.invalid.json` — processing status is not an action result.
- `world-state.invalid-version.json` — unsupported schema version.
- `scene-frame.invalid-type.json` — wrong revision type.
- `presentation-plan.invalid-type.json` — unknown reveal value.

`world-state.invalid-reference.json` and `presentation-plan.invalid-reference.json`
are deliberately JSON-Schema-valid. They are rejected by the semantic reference
checks exported from `@living-history/contracts`; JSON Schema validates shape,
not membership of one entity ID in another array.
