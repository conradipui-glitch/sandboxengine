# Florence real quest — B11

This package is the first Engine-side representation of the real `florence-workshop` scenario from `conradipui-glitch/sandbox` commit `092bcef0be5943e32bf02f08f9e9d4cde393fa95`.

## What is authoritative here

- `quest-release.json` + `blocks.json` use existing generic v1 authoring contracts.
- `initial-state.json` uses the generic v1 `WorldState`.
- `narrative-beats.json` is **example-owned authored data**, not a new Core/public contract. It preserves the six semantic source decisions while keeping each option's `clockAdvanceSeconds` explicit.
- `source-assets.json` freezes source provenance for the six visual assets and six Florence music groups. Its `binaryCopyStatus` remains pending until bytes are copied and verified; provenance is not mislabeled as ingestion.

The migration deliberately does not introduce `FlorenceMemory`, `if (florence)` or a six-turn invariant into Core.

## Comparison anchor

Canonical legacy route:

`draft → ledger → counter → pigment → public → deliver`

Representative counter-routes are kept in `narrative-beats.json` so later B11 semantic comparison is not tuned to one happy path.

The numeric resources in this package are quest-named operational state. They are not a mechanical copy of the legacy five generic metric labels.
