# Presentation JSON Schemas — v2

`packages/contracts/schemas/v2/` contains the canonical B07 presentation contracts. These schemas use JSON Schema Draft 2020-12 and `schemaVersion: "2.0"`.

This namespace exists because the B01 presentation schemas were intentionally narrow and already published as v1. They are not rewritten in place.

## Contracts

- `asset-manifest.schema.json` — immutable published asset metadata and SHA-256 identity used by presentation references. B07-01 defines the DTO only; upload, MIME sniffing, storage and deletion policy are B07-02.
- `scene-frame.schema.json` — complete player-safe final visual state for one session revision. Reload restores this frame directly without replaying historical effects.
- `presentation-plan.schema.json` — bounded, non-executable transition tree from one committed revision to the next.

## Presentation authority boundary

Presentation describes **how to show** an already committed result. It cannot:

- mutate `WorldState`;
- contain gameplay effects/state patches;
- commit a turn;
- execute arbitrary JavaScript, HTML or CSS;
- carry DOM selectors/callbacks;
- turn animation completion or user reading time into game-clock advancement.

`SceneFrameV2` is the authoritative final presentation state. `PresentationPlanV2` is disposable transition data tied to one `turnId` and `targetFrameId`. Skip/reduced-motion may jump directly to the target frame.

## Command set

Only these command leaves are valid:

- `background.set`;
- `actor.show`;
- `actor.hide`;
- `actor.move`;
- `actor.expression`;
- `item.show`;
- `dialogue.show`;
- `overlay.open`;
- `overlay.close`;
- `audio.play`;
- `audio.stop`;
- `wait`.

Tree composition uses only `sequence` and `parallel`. Transition/reveal/channel values are fixed presets. Durations, tree depth, child count and total node count are bounded by TypeScript semantic validation.

## Validation model

JSON Schema proves exact shape and rejects unknown fields. Semantic validators in `src/presentation-validation.ts` separately prove membership and cross-object invariants:

- asset ID + hash match an allowed frozen catalog entry;
- image/audio kind matches command/field purpose;
- visible actors/speakers/overlays/scenes are allowlisted;
- `layerOrder` covers the current visual layers exactly once;
- one plan is one forward commit (`fromRevision + 1 === toRevision`);
- plan `turnId` and `targetFrameId` match the target frame;
- tree depth/node/child bounds hold.

A shape-valid object with a hidden speaker, stale hash or unknown actor is therefore still rejected semantically.
