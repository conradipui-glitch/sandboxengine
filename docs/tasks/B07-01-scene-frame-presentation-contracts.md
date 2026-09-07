# B07-01 — SceneFrame + PresentationPlan contract boundary

## Цель

После published B06 зафиксировать переносимый presentation contract между Runtime/Presentation composer и Player, не возвращая presentation-слою gameplay authority.

База: published B06 merge `7a5efba36b508f674483dd9cce3762277917c5e1`, main CI `34081697268` — success.

Канонический источник: `docs/SPECIFICATION.md` §8.2 и §10.1–10.5.

## Главный invariant

**Core/Runtime определяют, что произошло; SceneFrame описывает разрешённый конечный вид; PresentationPlan описывает только как визуально перейти к этому кадру. Ни frame, ни plan не меняют WorldState и не создают gameplay callbacks.**

## Сделать

### 1. Versioned `SceneFrame`

Добавить строгий serializable contract полного текущего кадра.

Минимум:

- schema version;
- stable frame/scene IDs;
- source session/release/revision identity, достаточная для stale/replay checks без secret fields;
- optional background asset reference;
- ordered visual layers;
- actors with stable IDs, slots/positions and optional expression/asset refs;
- visible item images;
- UI overlays/windows;
- dialogue/history references needed for current view;
- current music reference;
- all player-visible text already authorized;
- no WorldState, effects, statePatch, resource min/max, storage/fencing/provider diagnostics.

Frame должен быть полным конечным состоянием presentation, пригодным для reload без повторного проигрывания исторических эффектов.

### 2. Versioned `PresentationPlan`

Добавить strict bounded transition plan:

- stable plan ID;
- `fromRevision`, `toRevision`;
- persisted `turnId`;
- root `sequence` / `parallel` tree;
- bounded depth/node count;
- leaves only from registered first-set commands.

Первый command set:

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

Запрещены arbitrary script/HTML/CSS/DOM selectors, executable callbacks, loops and unknown command types.

### 3. Preset-only presentation parameters

Переходы только из allowlist:

- `fade`;
- `slide`;
- `crossfade`;
- `typewriter` where applicable.

Duration bounded finite integer milliseconds. Никаких arbitrary CSS strings/easing code.

### 4. Asset-reference boundary

В B07-01 не строить upload/storage pipeline. Добавить только минимальный immutable asset-reference/manifest DTO, достаточный для contract validation:

- stable asset ID;
- content hash;
- MIME/category;
- optional dimensions/duration;
- alt text where visual;
- source/rights metadata fields as data;
- immutable hash identity.

Frame/plan references must resolve only against a supplied release asset catalog. Unknown asset ID/hash mismatch fails validation.

Полный asset ingestion/storage/format sniffing belongs to B07-02.

### 5. Referential validation

Добавить pure validator/compiler boundary, который проверяет:

- IDs unique and bounded;
- plan revisions exactly describe one forward committed transition;
- `turnId` present and stable;
- actor/item/dialogue/overlay/asset references exist in supplied allowed presentation catalog;
- plan cannot reference hidden/unallowed speaker/dialogue/asset IDs;
- final plan semantics are compatible with target `SceneFrame` for deterministically checkable properties;
- no unknown command/extra authority fields.

Не пытаться симулировать DOM/animation engine в validator.

### 6. Replay/stale semantics as contracts

Закрепить правила, нужные Player в следующих slices:

- reload uses latest `SceneFrame` and does not replay old plan;
- duplicate same `turnId` is replayable data, not a second presentation execution trigger;
- stale response with lower revision cannot replace newer frame;
- skip/reduced-motion must converge immediately to the same target `SceneFrame` and never call gameplay APIs.

B07-01 фиксирует pure decision helpers/contracts; browser renderer будет позже.

### 7. Tests

Минимум:

- valid frame serializes and validates;
- valid nested sequence/parallel plan validates;
- unknown command rejected;
- arbitrary CSS/script/extra field rejected;
- unknown asset/actor/dialogue/overlay ref rejected;
- wrong asset hash rejected;
- duplicate IDs rejected;
- invalid `fromRevision/toRevision` rejected;
- depth/node/duration bounds enforced;
- same final frame accepted for normal vs skip/reduced-motion path contract;
- stale revision helper refuses downgrade;
- presentation DTO contains no gameplay mutation authority;
- root `npm run verify` remains green.

## Functional acceptance

B07-01 functional gate закрыт, когда:

1. `SceneFrame` is a complete versioned player-safe final presentation state;
2. `PresentationPlan` is a bounded non-executable transition tree tied to one persisted turn;
3. all references are validated against explicit allowed catalogs/assets;
4. plan cannot mutate gameplay or carry arbitrary script/CSS/DOM authority;
5. stale/replay/skip convergence semantics are expressed and tested;
6. full root `npm run verify` green.

## Не делать

- asset upload/storage/transcoding/MIME sniffing — B07-02;
- actual browser animation/audio runtime — later B07 slice;
- Studio timeline/editor UI — later B07 slice;
- final responsive Player redesign — later B07 slice;
- UI plugin registry — B08;
- gameplay changes, Core effects, narrator authority expansion;
- B09+ auth/publish/author-helper/migration scope.

## Следующий slice

После published B07-01: **B07-02 — immutable asset registry + validated ingestion/storage boundary**, затем Player presentation renderer/skip/reload behavior.