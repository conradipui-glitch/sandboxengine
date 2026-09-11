# FIN-05B — ручная композиция экрана (слои/transform/animation/audio)

Дата: 2026-09-11. Worktree: `C:/Temp/lhc-fin05b-compose`, ветка `feat/fin05b-screen-composition`, вход `523dca5` (merge `feat/fin05-studio-screens`).
Runtime проверок: Node `24.19.0`, npm `11.17.0` (`npm ci` в этом worktree — lock без изменений).
Правило данных: `screens` — часть игрового контента и входит в `contentHash`; раскладка доски сюжета (`BoardDocument`) — view и в контент не входит.

## Что сделано

Второй bounded-срез FIN-05: композиция экрана в Studio (Vanilla TS/DOM, без React и новых клиентских зависимостей).

- **Чистая модель `apps/studio/src/screen-composition.ts`** над canonical `MissionSceneScreen`/`MissionScreenLayer` (без новых полей контракта):
  - `updateScreenLayer` — полная замена слоя (id сохраняется, патч валидируется fail-closed теми же правилами, что и `addScreenLayer`: тип/asset ref/X·Y [0…1]/scale/>0/opacity/Z целый);
  - `duplicateScreenLayer` (+`nextScreenLayerId`) — новый id, копия выше текущего топа, отказ на занятый/отсутствующий id;
  - `moveScreenLayer`/`translateScreenLayer` (кламп [0…1]), `resizeScreenLayer`/`scaleScreenLayerBy` (кламп 0.05…4), `rotateScreenLayer` (`normalizeRotation` → (-180,180]), `flipScreenLayer`, `setScreenLayerOpacity`, `toggleScreenLayerVisible`/`Locked`;
  - `reorderScreenLayer` (forward/backward/front/back) с детерминированной перенумерацией Z в уникальные целые 1..n; `applyScreenLayerAction` — диспетчер всех действий;
  - геометрия: `screenLayerBox`/`screenLayerContains`/`screenLayerHitTest` (верхний видимый), `applyScreenDrag`, `applyScreenResize` (пропорциональный, клампы, защита от нулевой дистанции);
  - фон: `fitScreenAsset(assetAspect, frameAspect, "contain"|"cover", focal)` — масштаб/смещение/видимая часть ассета (crop) с проекцией фокусной точки в центр кадра; `resolveScreenBackground` (own/inherited/none);
  - анимация: `normalizeAnimationPreset`, `resolveScreenAnimation(preset, {reducedMotion, paused})` — при reduced-motion/паузе внутренний transform не воспроизводится;
  - музыка: `resolveScreenMusic({hasTrack, muted, autoplayAllowed})` → `none|muted|blocked|playing` (+`shouldPlay`/label) — реальные mute/play с учётом autoplay;
  - клавиатура: `screenKeyAction` (стрелки/Shift — шаг 0.01/0.05, `[` `]` `{` `}` — порядок, V — видимость, L — блокировка, D — дублировать, Del/Backspace — удалить, Esc — снять выделение; строгие модификаторы) и `screenNudgeDelta`.
- **`apps/studio/src/screen-dom.ts`** — живая сцена: фон (contain/cover), слои с внешним transform (размещение), drag мышью и ручка resize, клавиатура; вся арифметика вызывается из чистого модуля, DOM только связывает события и колбэки (`onSelect`/`onTransform`/`onCommit`/`onNudge`/`onAction`/`onHint`).
- **`screen-model.ts`**: новый экспорт `replaceScreen(doc, nodeId, screen)` (слот scene/ending в одном шаге) — используется операциями слоёв.
- **`app.ts`**: `selectedScreenLayerId`; действия `screen-select-layer`, `screen-layer-action` (все операции), форма `screen-layer-edit` (полный transform слоя); инспектор показывает слои в порядке Z с кнопками (выше/ниже/наверх/вниз, flip H/V, видимость, закрепление, дублировать, удалить) и inline-форму выбранного слоя; монтаж сцены через `mountScreenIfNeeded`/`destroyScreen` с сохранением host между render'ами (как у доски сюжета). Drag/resize пишутся через тот же CAS-путь `POST /mission`.
- **`styles.css`**: `.screen-stage*`, `.screen-layer*`, ручка resize, состояние «скрыт/закреплён/выбран».

## Проверка (фактические результаты)

| Команда | Результат |
|---|---|
| `node --test apps/studio/test/fin05b-screen-composition.test.mjs` **до реализации** (модуль `dist/src/screen-composition.js` отсутствует) | **RED**: `ERR_MODULE_NOT_FOUND … screen-composition.js` (проверено перемещением файла) |
| то же после реализации | **16/16** |
| `npm run typecheck` (= `tsc -b`) | exit 0 |
| `npm run test:studio` | **142 pass, 0 fail, 1 skip** (было 126; +16) |
| `npm run test:contracts` | 57/57 |
| `npm run test:control` | 106/106 |
| `npm run test:server` | 141/141 |
| `npm run check:boundaries` | exit 0 (новых зависимостей и нарушений границ нет) |
| `npm run docs:check` | exit 0 (14 navigation docs, 10 generated contracts актуальны) |

Покрытие `fin05b-screen-composition.test.mjs` (16 тестов):
- валидация и fail-closed `updateScreenLayer` (bad transform/opacity/scale/Z, missing node/layer), вход не мутируется, id сохраняется;
- duplicate: новый id, `z = top+1`, отказ на занятый/отсутствующий;
- move/translate/resize/rotate(normalize)/flip/opacity/toggle — клампы детерминированы;
- z-order: шаг на одну позицию, front/back, детерминированная перенумерация, безопасный no-op; диспетчер действий (в т.ч. duplicate+delete);
- hit-test: верхний видимый слой, скрытый не ловится, пустая область → null;
- drag: точка под курсором становится центром с клампом; resize: отношение дистанций, кламп к max, защита от нулевой дистанции;
- contain/cover + фокус: центрирование, crop, проекция фокуса в центр кадра, NaN-safe;
- наследование фона own/inherited/none; preset + reduced-motion/пауза; музыка none/muted/blocked/playing;
- клавиатура: все биндинги + строгие модификаторы;
- **`screens` входят в `contentHash`**: правка transform меняет хэш, документ остаётся валидным (`validateMissionDraft` = []);
- Studio render: кнопки действий слоя, `data-screen-host`, inline-форма ровно у выбранного слоя (и отсутствует без выбора);
- реальный `screen-dom.ts` через DOM-шим: drag двигает слой и коммитит transform, ручка resize увеличивает масштаб, клавиши (Arrow/`]`/Delete/Esc) доходят до колбэков;
- **интеграция с настоящим Control + SQLite** через loopback-proxy Studio: добавление/правка слоя персистятся через canonical `POST /mission` и читаются обратно (`getMission`), нового пути записи не создано.

## Не проверено / остаётся из FIN-05

- **Браузерный проход gated Studio не выполнялся** (gate не ослаблялся, credentials не подбирались). Есть DOM-шим-тест реального `screen-dom.ts` и regression `B05-02 dev:studio` с настоящим Control, но живого входа и пиксельной приёмки сцены не было.
- **Реальная библиотека материалов не подключена**: hash/MIME/размеры, загрузка файла, переживание другого браузера/restart — остаются; сцена принимает `AssetRefV2` (assetId+SHA-256), но выбора из библиотеки с реальными файлами нет.
- **Сцена не подключена к Player/сайту/runtime/BFF**: фон/слои/preset/музыка воспроизводятся только в редакторе Studio, не в прогоне и не в каталоге.
- **Экраны истории (intro/scene/dialogue/choice/ending) в реальном runtime** и «перелистывание вступлений не тратит ход» — не в этом срезе.
- **Экспорт/импорт композиции** — не в этом срезе.
- **Приёмка FIN-05** (3+ сцены, 2 ветви, 2 финала, intro, диалог, фон и 3 PNG, другой браузер, сравнение preview/frozen playtest/сайт) — не достигнута.

Статус по факту: **PARTIAL** — композиция экрана доведена до проверяемой модели, DOM-сцены и записи через `/mission`; реальная библиотека материалов, воспроизведение в runtime/сайте и browser-приёмка остаются.
