# ADR: Studio → миссия → игровой сайт (M00)

Дата: 2026-09-10. SHAs: engine `63ebda8` (branch `feat/b13-acceptance-closure`), site `55504e7` (branch `feat/florence-vertical-slice`, копия `C:/Temp/lhc-site-audit-20260910`, clean).

## Проверено STATIC (без запуска тестов продукта)

- Site catalog: `src/worker/scenarios.ts:28` — hardcoded `scenarioSummaries`; сайт читает через `/api/scenarios`.
- Site runtime gate: `src/worker/engine-bff.ts:119` — engine только для `florence-workshop`, иначе `legacy`. Новый квест без правки кода через него не играется.
- Engine presentation: `packages/contracts/src/presentation-v2.ts` — AssetRefV2 (assetId+sha256), AssetManifestV2, слои actor/item/overlay, layerOrder. Переиспользовать.
- Engine authored runtime: `apps/server/src/authored-scenario.ts:221` — `scenario.beats[state.revision]`: номер revision выбирает сцену. Для ветвящихся миссий заменить на явный `currentSceneId`; revision остаётся счётчиком изменений.
- Engine draft/release: Control save/proposals/validation/history/freeze/release существуют; BoardDocument/boardRevision (K05) остаётся отдельно от contentRevision.
- Site styles: тёмная тема `#12110f`/`#ded7c8`/`#c94c36`, `character-breathe` — источник токенов Studio.

## Канонические имена (окончательные)

- `MissionDraft` = identity (projectId, questId, schemaVersion, contentRevision) + listing + story + screens + defaults + asset refs. Слово UI — «Миссия».
- `MissionReleaseBundle`: manifestVersion, projectId, questId, releaseId, contentHash (канонический payload без self-reference), story, screens, listing, asset hashes, rendererCompatibility.
- `PublicationRecord`: publicMissionId/slug ↔ projectId/questId/releaseId/contentHash + channel (preview/production).
- Переход хода: `{ currentSceneId, choiceId }` → сервер применяет choice (условия/эффекты/цель) одним идемпотентным ходом. `state.revision` в выборе сцены не участвует.

## Переиспользовать / новое

- Reuse: presentation-v2 контракты, AssetManifestV2, Control draft/validation/freeze/release/history/export/import, BoardDocument, published-session-binding (SQLite), site CSS-токены и анимации (с разделением authored-transform / animation-transform).
- New: story/screens/listing schemas + migration (M01), scene-executor с currentSceneId + legacy sidecar-адаптер (M02), asset upload/library (M03), preview entrypoint + iframe bridge (M04), сюжетная доска/редактор экранов (M05), listing/catalog/publish API + site BFF resolve (M06), multi-provider settings (M07), writer proposal (M08), мастер/тур (M09).

## Контракты запросов (черновик M01/M06)

- Engine Control: `POST /control/v1/projects/{p}/quests/{q}/mission` (full MissionDraft, CAS по contentRevision) → `GET` → `POST .../mission/validate` → `POST .../mission/freeze` → `POST .../publications` (idempotent key) → `GET /catalog/v1/missions` (public, только публичные поля).
- Site BFF: `GET /api/scenarios` остаётся совместимым (legacy-адаптер); `POST /api/session/start { publicMissionId }` резолвит publication registry → binding release/hash; каталог с revision/ETag, без скрытого hardcoded fallback.

## Решения

- V07–V08 (комментарии/курсоры) остаются после маршрута; тёмная тема вместо светлой мастерской; paint-only ИИ не делаем.
- Две рабочие копии, schemaVersion согласуется через commits; в копии K-исполнителя параллельный агент не пишет.
