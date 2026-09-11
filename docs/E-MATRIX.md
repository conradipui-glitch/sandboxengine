# E-матрица: сквозная приёмка авторства (FIN-11)

Один воспроизводимый прогон живого HTTP-сервера закрывает весь маршрут автора.
Тест: `apps/server/test/fin11-authoring-journey.test.mjs`
Имя теста в отчёте `node --test`: **`FIN-11: один авторский маршрут от пустого проекта до двух разных финалов`**

Харнесс: реальный `createControlHttpServer` + `SQLiteControlStore` / `SQLiteControlReleaseStore` /
`SQLiteControlPublicationStore` на временном файле SQLite, `buildPluginRegistry([])`.
Моки не используются: каждый шаг идёт по настоящему HTTP-маршруту, ни один шаг не обходит
маршрут вызовом стора напрямую. Схема SQLite не менялась.

Один тест намеренно покрывает весь маршрут: шаги связаны состоянием (релиз нельзя собрать
без валидации, каталог — без публикации, ход игрока — без сессии), и разрыв цепочки обязан
валиться именно на том шаге, где связь порвалась. Проверка несущей способности (см. ниже)
подтверждает, что тест падает от двух независимых временных мутаций.

## Маршрут → маршрут HTTP → что доказывает → имя теста → не покрыто

| # | Шаг маршрута | HTTP-маршрут (метод) | Что доказывает тест (фактические утверждения) | Имя теста | Не покрыто этим тестом |
|---|---|---|---|---|---|
| 1 | Создать проект | `POST /control/v1/projects` | 201; `project.projectId` совпадает | FIN-11: один авторский маршрут… | Конфликт `409 PROJECT_EXISTS`, роли/участники проекта, `GET /control/v1/projects` |
| 2 | Создать миссию (quest) | `POST /control/v1/projects/{p}/quests` | 201; `draft.questId` совпадает; затем `GET …/quests` отдаёт ровно этот quest | FIN-11: один авторский маршрут… | `POST` с невалидными `initialBlocks` (422), `409 QUEST_EXISTS`, `GET` несуществующего проекта |
| 3 | Доска: чтение до записи | `GET /control/v1/projects/{p}/quests/{q}/board` | 200; `boardRevision === 0`, `positions === {}` — до первого сохранения доска пуста и осмысленна | FIN-11: один авторский маршрут… | 404 для чужого/несуществующего quest, 501 `BOARD_STORAGE_UNAVAILABLE` |
| 4 | Доска: сохранить позиции узлов | `POST /control/v1/projects/{p}/quests/{q}/board/changes` | 200; `boardRevision === 1`; затем `GET …/board` отдаёт **ровно те** `{start:{x,y}, dock:{x,y}}` — позиции узлов сохранены и прочитаны обратно | FIN-11: один авторский маршрут… | `409 BOARD_REVISION_CONFLICT`, `409 BOARD_IDEMPOTENCY_KEY_REUSED`, границы координат, idempotent-replay ветка |
| 5 | Документ миссии: 2 сцены, развилка из 2 выборов, 2 финала | `POST /control/v1/projects/{p}/quests/{q}/mission` | 200; `contentRevision === 1`; `story.scenes.length === 2`; у входной сцены `choices.length === 2` (развилка); `story.endings.length === 2` | FIN-11: один авторский маршрут… | `409 MISSION_REVISION_CONFLICT`, `409 MISSION_IDEMPOTENCY_KEY_REUSED`, `422 INVALID_MISSION_DOCUMENT` (схема/семантика), условия и эффекты выборов |
| 6 | Документ миссии: чтение | `GET /control/v1/projects/{p}/quests/{q}/mission` | 200; `contentHash` совпадает с ответом сохранения | FIN-11: один авторский маршрут… | История ревизий (`/draft/history`), черновики блоков (`/draft`, `/draft/changes`) |
| 7 | Экраны intro / scene / ending | отдельного маршрута нет — экраны хранятся **внутри документа миссии** (`screens`), поэтому доказываются шагом 5–6 | `screens.intros.length === 1`; `Object.keys(screens.scenes).sort() === ["dock","start"]`; `Object.keys(screens.endings).sort() === ["dawn","dusk"]` — сохранены интро, экраны обеих сцен и экраны обоих финалов | FIN-11: один авторский маршрут… | Ассеты в экранах (`background`/`music`/слои с `asset`), правила `inheritBackground`, валидация презентации, слои с реальными AssetRefV2 |
| 8 | Валидация | `POST /control/v1/projects/{p}/quests/{q}/validations` | 201; выдан `validationId`; сервер также вернул readiness (используется дальше сборкой) | FIN-11: один авторский маршрут… | `404` при неизвестной ревизии, `VALIDATION_SNAPSHOT_MISMATCH`, невалидный черновик |
| 9 | Сборка релиза | `POST /control/v1/projects/{p}/quests/{q}/releases` | 201; `release.releaseId === "release-1"`; `isCurrent === false` — сборка **не** публикует | FIN-11: один авторский маршрут… | `422 RELEASE_FREEZE_FAILED` (нет ассета), `409 VALIDATION_SNAPSHOT_MISMATCH`/`RELEASE_EXISTS`, повтор с тем же ключом, `diceCheckDefinitions` |
| 10 | Публикация | `POST /control/v1/projects/{p}/quests/{q}/publish` | 200; `catalog.publicMissionId === "mission:project:quest"`; зафиксирован `slug` | FIN-11: один авторский маршрут… | `409 CURRENT_RELEASE_CONFLICT`, `409 PUBLICATION_SLUG_CONFLICT`, `PUBLICATION_SOURCE_STALE`, откат (`/rollback`), снятие с публикации (`/publication/unpublish`) |
| 11 | Каталог (список) | `GET /public/v1/missions` | 200; опубликованная миссия найдена по `publicMissionId`; `releaseId === "release-1"` | FIN-11: один авторский маршрут… | Пустой каталог, `400 INVALID_PUBLIC_CATALOG_REQUEST` при query-параметрах, несколько миссий |
| 12 | Каталог (одна миссия) | `GET /public/v1/missions/{identifier}` | 200; отдаётся по публичному идентификатору; `mission.slug` совпадает с каталожным | FIN-11: один авторский маршрут… | `404` для снятой/несуществующей миссии, запрос по слагу отдельным шагом |
| 13 | Сессия игрока | `POST /public/v1/missions/{identifier}/sessions` | 201; `session.currentSceneId === "start"`; выдан строковый `credential` | FIN-11: один авторский маршрут… | `409 PUBLIC_MISSION_RELEASE_STALE`, `409 PUBLIC_MISSION_ASSET_CHANGED`, `PUBLIC_MISSION_SESSION_CONFLICT`, старт по снятой публикации |
| 14 | Гейт сессии | `GET /public/v1/missions/{identifier}/sessions/{sid}` | 401 без креда — сессия игрока не читается без предъявленного креда | FIN-11: один авторский маршрут… | Чтение с корректным кредом, чужая сессия/чужой публичный идентификатор (404) |
| 15 | Ход игрока, ветвь A | `POST /public/v1/missions/{identifier}/sessions/{sid}/turns` | 200; `target === {kind:"ending", endingId:"dawn"}`; `session.turn === 1` | FIN-11: один авторский маршрут… | Ветки условий/эффектов, `choice_blocked`, `effect_failed`, `choice_not_in_scene` |
| 16 | Ход по ветви B (шаг 1) | `POST /public/v1/missions/{identifier}/sessions/{sid}/turns` | 200; `target === {kind:"scene", sceneId:"dock"}`; `session.currentSceneId === "dock"` — ветвь уводит в другую сцену, а не к финалу | FIN-11: один авторский маршрут… | Переход по условиям, ветвление из середины истории |
| 17 | Ход по ветви B (шаг 2) | `POST /public/v1/missions/{identifier}/sessions/{sid}/turns` | 200; `target === {kind:"ending", endingId:"dusk"}`; `session.turn === 2` | FIN-11: один авторский маршрут… | Идемпотентный повтор этого хода, ход из несуществующей сцены |
| 18 | **Два разных финала разными путями** | (шаги 15–17) | `world.terminal.outcome` ветви A `=== "dawn"`, ветви B `=== "dusk"`; `outcome !== outcome` — финалы различны; длина пути различна (`turn 1` vs `turn 2`); креды сессий различны; `mission.contentHash`, доехавший до игрока, равен авторскому | FIN-11: один авторский маршрут… | Одновременные сессии одной миссии, повторный старт той же сессии другим кредом |
| 19 | **Повторный ход после финала отвергается** | `POST /public/v1/missions/{identifier}/sessions/{sid}/turns` | 409 `MISSION_TURN_CONFLICT` при повторной отправке последнего хода (тот же `baseTurn`, новый ключ) — состояние ушло вперёд, повтор не проходит | FIN-11: один авторский маршрут… | `409 MISSION_IDEMPOTENCY_KEY_REUSED` (тот же ключ, другой запрос) |
| 20 | Ход из завершённого мира (дополнительно) | `POST /public/v1/missions/{identifier}/sessions/{sid}/turns` | 422 `MISSION_TURN_MISSION_ENDED` при `baseTurn`, равном текущему, — второй, отличный от 409, честный отказ «история окончена» | FIN-11: один авторский маршрут… | Прочие 422-исходы движка |
| 21 | Идемпотентный повтор хода (контроль) | `POST /public/v1/missions/{identifier}/sessions/{sid}/turns` | 200 и `replay === true` при повторе того же запроса с тем же ключом — доказывает, что 409 в шаге 19 вызван сдвигом хода, а не запретом повторов как таковым | FIN-11: один авторский маршрут… | Повторы на остальных маршрутах |

## Явно не покрыто этим тестом (сводно)

- **Аутентифицированный режим**: роли (`owner`/`editor`/`tester`), логин/сессии/CSRF, `GET /control/v1/projects` как список проектов пользователя, участники проекта, presence (FIN-13), блокировки редактирования (FIN-13).
- **Ассеты**: загрузка (`POST …/assets`), отдача публичных и сессионных байтов, ре-валидация/ETag, `ASSET_CHANGED`/`ASSET_MISSING` при заморозке, экраны с реальными `AssetRefV2`.
- **Черновик блоков**: `POST …/draft/changes`, `GET …/draft`, история `…/draft/history`, compare, references, restore, import/export/clone.
- **Публикация-под-нагрузкой**: CAS-конфликты, слаг-конфликты, откат на предыдущий релиз, снятие с публикации, восстановление прерванной публикации после рестарта (FIN-02), квоты/дедлайны рантайма (B12).
- **Коллаборация** (FIN-12): заметки, комментарии, статусы, CAS-правки.
- **Плейтесты** и трассы плейтестов.
- **Провайдеры/авторский ассистент**: `authorAssistant`, agent-kit handshake, MCP.
- **Не валидируется подпись/целостность validated-снапшота** сверх того, что даёт маршрут сборки.

## Проверка несущей способности (временные мутации, откат через `cp`)

Обе мутации — временные, откат выполнен копированием из бэкапа (`cp`), `git checkout --` не использовался.

1. **Мутация логики теста**: в фикстуре развёрнуты финалы ветвей (`cut-loose: dawn→dusk`, `raise-sail: dusk→dawn`).
   Прогон **упал** на `assert.deepEqual(branchA.body.target, {kind:"ending", endingId:"dawn"})` —
   `actual {endingId:'dusk'}`. Значит тест фиксирует, **какая** ветвь ведёт к **какому** финалу,
   а не просто «финалов два». После отката прогон снова зелёный.
2. **Мутация логики маршрута**: в `routePublicMissionSession` (`apps/server/src/control-server.ts`)
   гейт креда инвертирован (`!==` → `===`), `tsc -b`, прогон.
   Прогон **упал** на `assert.equal(uncredentialed.status, 401)` — `actual 200`.
   Значит тест наблюдает настоящую проверку креда на HTTP-границе, а не свою же договорённость.
   После отката из бэкапа (`md5` совпал) и `tsc -b` прогон снова зелёный.

## Как воспроизвести

```
cd C:/Users/kato55/lhc-fin11-journey
C:/Users/kato55/AppData/Local/Temp/node-v24.19.0-win-x64/node.exe node_modules/typescript/bin/tsc -b --force
C:/Users/kato55/AppData/Local/Temp/node-v24.19.0-win-x64/node.exe --test apps/server/test/fin11-authoring-journey.test.mjs
```
