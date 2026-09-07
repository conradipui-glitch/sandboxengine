# ADR 0022 — Presentation v2: конечный SceneFrame и bounded transition plan

Дата: 2026-09-07  
Статус: accepted в B07-01 после functional gate

## Контекст

B06 опубликован полностью и фиксирует причинный путь до structured action/playerView/narrative. Следующий слой должен показать уже рассчитанный результат: фон, актёров, предметы, диалог, overlays, звук и переходы. Главный риск — превратить presentation в второй gameplay resolver либо сделать анимационный скрипт исполняемой программой.

В B01 уже были опубликованы узкие `SceneFrame` / `PresentationPlan` схемы `1.0`. Они покрывали только ранний subset и одновременно зафиксировали правило: breaking contract нельзя расширять молча под тем же `$id`. Поэтому B07 не переписывает presentation v1 на месте.

## Решение

### 1. Core contracts остаются 1.0, presentation получает отдельную версию 2.0

`CONTRACT_SCHEMA_VERSION = 1.0` не меняется.

Добавлен отдельный `PRESENTATION_SCHEMA_VERSION = 2.0` и новые стабильные IDs:

- `urn:living-history:schema:asset-manifest:2.0`;
- `urn:living-history:schema:scene-frame:2.0`;
- `urn:living-history:schema:presentation-plan:2.0`.

Legacy presentation v1 остаётся доступным и frozen. Generated agent docs теперь одновременно показывают core schema version и presentation schema version, не объявляя v2 заменой всех контрактов движка.

### 2. SceneFrameV2 — авторитетное конечное состояние presentation

`SceneFrameV2` является полным player-safe кадром конкретной session/release/revision:

- stable frame/scene/session/quest/release IDs;
- revision и persisted turn identity;
- immutable background asset ref;
- ordered actor/item/overlay layers;
- actor entity, slot, expression и asset ref;
- item visuals;
- overlays;
- dialogue history + current line;
- current music.

Reload восстанавливает последний frame напрямую. Для восстановления кадра не требуется повторять исторический `PresentationPlan`.

Frame не содержит `WorldState`, gameplay effects/statePatch, resource min/max, storage/fencing/provider diagnostics или executable callbacks.

### 3. Asset identity в presentation — `assetId + SHA-256 hash`

B07-01 вводит только immutable manifest/reference DTO. Файл считается тем же опубликованным asset только при совпадении stable ID и content hash.

Manifest ограничен поддерживаемыми image/audio MIME, dimensions/duration и metadata source/rights. Визуальный asset требует alt text.

Upload, MIME sniffing, storage, deduplication и deletion policy намеренно остаются B07-02.

### 4. PresentationPlanV2 — bounded non-executable transition tree

Plan привязан к одному persisted turn и одному target frame:

- `fromRevision`;
- `toRevision`;
- `turnId`;
- `targetFrameId`;
- root `sequence` / `parallel` tree.

Разрешённые leaves первого набора:

`background.set`, `actor.show`, `actor.hide`, `actor.move`, `actor.expression`, `item.show`, `dialogue.show`, `overlay.open`, `overlay.close`, `audio.play`, `audio.stop`, `wait`.

Transitions/reveal/channels — только фиксированные presets. Duration, tree depth, child count и node count ограничены. Arbitrary JS/HTML/CSS, DOM selectors, loops, callbacks и неизвестные commands не являются частью контракта.

Animation completion, typewriter completion, audio completion и кнопка чтения не являются gameplay commit или продвижением игровых часов.

### 5. Проверка разделена на shape, membership и convergence

JSON Schema доказывает exact shape и `additionalProperties:false`.

Semantic reference validator отдельно доказывает:

- scene/entity/speaker/overlay membership;
- asset ID/hash/kind;
- unique IDs;
- exact layerOrder coverage;
- one-turn identity `N → N+1`;
- target frame / turn binding;
- bounded tree.

После первого green corpus-а audit обнаружил дополнительный gap: разрешённая команда могла ссылаться на валидный asset/actor, но закончиться не тем состоянием, которое объявлено target frame.

Поэтому добавлен pure presentation convergence gate. Он симулирует только детерминируемые presentation properties — background, actor visibility/slot/expression, item visuals, overlay visibility, active dialogue и music — и требует финального совпадения с `SceneFrameV2`.

Для `parallel` разные branches стартуют от одного visual state. Запись разных значений в одно свойство конфликтует и отклоняется; одинаковая запись допустима. Массив children не превращается в скрытый порядок разрешения конфликтов.

Этот симулятор не читает Core/WorldState, не исполняет gameplay effects и не вызывает Runtime commit API.

### 6. Replay/stale — pure Player decisions

Контрактные helpers фиксируют:

- lower revision = stale;
- same revision + same frame = duplicate;
- same revision + другой frame = conflict;
- already played/current `turnId` не запускает plan повторно;
- gap между revision требует восстановить latest frame, а не угадывать промежуточное состояние.

Skip/reduced-motion в следующих renderer slices обязан прийти к тому же target `SceneFrame`, не вызывая gameplay callbacks.

## Доказательство

Regression corpus проверяет:

- v1 остаётся неизменным, v2 имеет отдельные `$id`;
- immutable asset hashes и image/audio semantics;
- hidden speaker/actor/overlay и wrong hash fail closed;
- полный command set и nested sequence/parallel;
- arbitrary CSS/script/DOM command rejection;
- depth/node/duration bounds;
- stale/duplicate delivery decisions;
- final-frame convergence;
- разрешённый, но другой background/slot отклоняется как divergent;
- conflicting parallel writes fail closed;
- presentation public DTO не содержит gameplay mutation/executable keys.

Ранний CI `34082918924` показал: typecheck и весь кодовый regression suite green; единственной ошибкой были ожидаемо stale generated agent docs после нового schema namespace.

После синхронизации generated docs и convergence hardening functional head `068890e3bce15d0686b753df4d2f4ed1bcbda9f4` прошёл полный CI `34083432560` — success (`npm run verify`).

## Не решено этим ADR

- asset upload/storage/hash calculation/MIME sniffing/dedup — B07-02;
- фактический browser animation/audio executor;
- reduced-motion/skip/reload E2E в браузере;
- Studio scene/timeline authoring UI;
- UI plugin registry — B08;
- расширение gameplay authority, Core mechanics или narrator authority.
