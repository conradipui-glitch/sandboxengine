# Передача работы

Обновлено: 2026-09-07

Текущий блок: **B07-01 — SceneFrameV2 + bounded PresentationPlanV2**  
База: published B06 final merge `7a5efba36b508f674483dd9cce3762277917c5e1`  
B06 push-CI main: `34081697268` — success  
Ветка: `b07-01-scene-frame-presentation-contracts`  
PR: #24  
Статус: **functional gate `34083432560` success на `068890e3bce15d0686b753df4d2f4ed1bcbda9f4`; docs sync → final current-head CI → merge/main publication gate**

## Что уже published

B01–B06 published полностью.

Final B06 merge: `7a5efba36b508f674483dd9cce3762277917c5e1`.  
Main CI: `34081697268` — success.

Canonical B06 path:

`claim → optional intent → validated ResolvedIntent → Core → FactPacket → narrator/fallback → one persisted commitTurn`.

Canonical B06 audit unresolved BLOCKER=0. Current Codex no-tools compatibility remains limited; production Runtime adapter was intentionally not added.

## Что реализовано в B07-01

### Contract versioning

B01 presentation v1 is already published and frozen. B07 does not widen its `$id`.

Core contracts remain `1.0`; new complete presentation contracts use `PRESENTATION_SCHEMA_VERSION = 2.0`:

- asset manifest `2.0`;
- SceneFrame `2.0`;
- PresentationPlan `2.0`.

Legacy TypeScript v1 names remain exported; B07 contracts use explicit `*V2` names.

### SceneFrameV2

Complete player-safe final frame for one frozen session/release/revision:

- stable frame/scene/session/quest/release identity;
- revision + persisted turn identity;
- immutable background ref;
- exact ordered actor/item/overlay layers;
- actor entity/asset/slot/expression;
- dialogue history + active line;
- current music.

Frame does not carry WorldState, effects, statePatch, resource bounds, provider/storage/fencing internals or executable callbacks.

Reload restores the latest frame directly; historical presentation effects are not replayed.

### PresentationPlanV2

One bounded visual transition tied to:

- `fromRevision`;
- `toRevision`;
- `turnId`;
- `targetFrameId`.

Tree combinators: `sequence`, `parallel`.

Leaves:

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

Only preset transitions/reveal/channels are accepted. No arbitrary JS/HTML/CSS, selectors, loops or callbacks.

Tree depth/node/children and durations are bounded.

### Asset references

Presentation uses immutable `assetId + SHA-256 hash`.

`AssetManifestV2` stores bounded presentation metadata and accepted first MIME set. B07-01 only defines/validates this DTO.

Not yet implemented: file upload, content hashing pipeline, MIME sniffing, storage, deduplication/deletion. Those are B07-02.

### Validation layers

1. JSON Schema exact shape and no extra authority fields.
2. Semantic reference validation: scene/entity/speaker/overlay allowlists, asset hash/kind, unique/layer references, `N→N+1`, target turn/frame, tree limits.
3. Full target-frame convergence.

The convergence gate was added after audit found a real gap: reference-valid commands could still end on a different allowed visual state.

Pure visual convergence checks only:

- background;
- actor visibility/slot/expression;
- item visuals;
- overlay visibility;
- active dialogue;
- music.

It does not read or mutate Core/WorldState and has no Runtime commit callbacks.

Parallel branches start from the same visual state. Different writes to the same property conflict; identical writes are allowed. There is no accidental array-order conflict resolution.

### Replay/stale decisions

Pure helpers define:

- lower incoming revision → stale;
- same frame/revision → duplicate;
- same revision, other frame → conflict;
- applied/current turn ID → duplicate, no second plan playback;
- revision gap → recover latest frame instead of guessing.

Renderer skip/reduced-motion must jump to the same target frame without gameplay callbacks; browser implementation is later B07 scope.

### Generated agent contracts

Generator now supports separate schema namespaces:

- core `1.0`;
- presentation `2.0`.

`schema-index.json` contains both legacy presentation v1 and canonical v2 entries with explicit versions.

`capabilities.json`/SKILL publish the complete v2 presentation command set.

Registry hash: `0b1fa6e4e23374cc00fd5cca61ecbbc0aec2a5df3ab83c1da2ce82fb8cf6e36c`.

## CI evidence

Initial run `34082918924`:

- all type/code tests and boundaries green;
- only stale generated docs failed.

Generated docs sync commit: `0cdb1503affb40e098b25673e7a63c7989dbe7c8`.

Semantic convergence hardening head: `068890e3bce15d0686b753df4d2f4ed1bcbda9f4`.

Full PR CI `34083432560` — **success**, including root `npm run verify`.

ADR: `docs/decisions/0022-presentation-v2-final-frame-boundary.md`.  
Worklog: `docs/worklog/2026-09-07-b07-01.md`.

## Functional acceptance state

Закрыто функционально:

- legacy presentation v1 preserved;
- presentation v2 separate schema namespace;
- complete final SceneFrame;
- bounded non-executable transition tree;
- full first command set;
- immutable asset ID/hash references;
- allowlist/hash/layer/revision validation;
- target-frame convergence and parallel-conflict safety;
- stale/replay helpers;
- multi-version generated docs;
- B01–B06 regressions green.

## Publication Gate

Осталось:

1. final current-head PR CI после docs sync;
2. mark PR #24 ready;
3. merge with pinned expected head SHA;
4. verify exact merge-SHA push-to-main CI;
5. only then B07-01 published.

## Следующее после B07-01 publication

**B07-02 — immutable asset registry + validated ingestion/storage boundary**:

- trusted server-side content hashing;
- size/MIME/type validation;
- immutable storage identity;
- dedup/reference semantics;
- image/audio metadata validation;
- safe missing/corrupt asset behavior;
- no arbitrary SVG/HTML/executable asset path.

Create B07-02 only from verified B07-01 merge SHA.

## Не делать сейчас

Browser animation/audio executor, final visual Player redesign, Studio scene/timeline editor, UI plugin registry/B08, B09 auth/public publish, B10 author AI, B11 Florence migration or force dependency upgrade.
