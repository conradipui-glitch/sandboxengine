# Полное ревью кода — план и собственные находки оркестратора

Дата: 2026-09-11. Причина: большая часть кода проекта написана простыми ИИ-моделями,
владелец регулярно получает неожиданные ошибки. Нужен не выборочный взгляд, а
систематическое ревью всей логики.

## Зоны ревью (10 независимых ревьюеров, делегация `deleg_7b2415a0`)

| # | Зона | Объём |
|---|---|---|
| 1 | `packages/control/src/sqlite-store.ts` + `types.ts` | ядро хранилища, миграции схемы |
| 2 | остальные модули `packages/control/src` | публикация, релизы, миграция релизов, задания агента |
| 3 | `apps/server/src/control-server.ts` | вся HTTP-поверхность Control |
| 4 | остальные `apps/server/src` | presence, аренды, ход, кэш ассетов, помощник |
| 5 | `apps/studio/src/app.ts` | состояние мастерской и поток публикации |
| 6 | остальные `apps/studio/src` | доска, экраны, api, presence, конфликты |
| 7 | `packages/core` + `packages/contracts` | движок истории, канонизация, валидация |
| 8 | `packages/runtime` + `player` + `assets` + `plugins` | рантайм прохождения, ассеты, плагины |
| 9 | `apps/player` + `packages/ai` + `apps/builder-runner` | плеер, провайдеры ИИ, builder |
| 10 | `scripts/*`, сборка/CI, доки против факта | честность проверок и заявлений |

Объём кода: 413 файлов, ~97 тыс. строк (без тестов ~56 тыс., тесты ~41 тыс.).
Правило приёмки: находка принимается только с доказательством — воспроизведённое
поведение (команда + вывод) либо явная пометка «только чтение кода». Стиль,
именование и длина функций находками не считаются.

## Собственные находки (до отчётов ревьюеров)

### R-01. «Проверено ✓», но выпуск собрать нельзя (высокая, исправлено)

Живой прогон мастерской (`http://127.0.0.1:4185`, чистая temp-БД, headless Chrome CDP):

1. «Проверить» → `POST /validations` отвечает `status: "valid"`, ошибок нет;
2. «Подготовить release build» → `POST /releases` отвечает
   `422 {"error":{"code":"RELEASE_FREEZE_FAILED","detailCode":"MISSION_REVISION_UNAVAILABLE"}}`;
3. в интерфейсе автор видит только «Control API: RELEASE_FREEZE_FAILED.» — без
   `detailCode` и без объяснения, что делать.

Причина (проверено диагностическим скриптом на той же БД): `getMissionHistory()`
для этой миссии возвращает 0 записей и `getMission()` — `null`, то есть у миссии
нет authored-ревизии истории вовсе: доска/блоки есть, а документа истории нет.
Сервер отказывается морозить выпуск без пина — это честное поведение, дефект не в
нём. Дефект в согласованности: **проверка черновика объявляет его валидным, хотя
выпуск из него не собирается**, и автор узнаёт об этом только на следующем шаге,
сообщением без причины и без следующего действия.

Что нужно: либо валидация обязана замечать «миссия без authored-ревизии истории»
и говорить это прямо, либо сообщение о `RELEASE_FREEZE_FAILED` обязано показывать
`detailCode` по-русски с указанием, что сделать. Сейчас нарушен целевой сценарий
владельца: «проверил → собрал выпуск → опубликовал».

**Исправлено и доказано живьём.**

1. Сервер: доступность authored-ревизии вынесена в одну функцию
   `resolveAuthoredMissionRevision` (`apps/server/src/control-server.ts`), которой
   пользуются и сборка выпуска, и проверка. Ответ `POST /validations` теперь несёт
   `releaseReadiness: {status:"ready"|"blocked", code?}`; коды — те же, что вернула бы
   сборка (`MISSION_REVISION_UNAVAILABLE`, `ASSET_MISSING`).
2. Мастерская: панель проверки показывает предупреждение
   `[data-release-blocked]`, а сообщения об отказах переведены на русский с
   действием автора (`apps/studio/src/control-errors.ts`, `describeControlError`,
   `describeReleaseReadiness`); сырое `Control API: <CODE>.` из интерфейса убрано.
3. Доказательства: `apps/server/test/fin-validate-freeze-consistency-http.test.mjs`
   (проверка говорит `blocked` + сборка отвечает тем же кодом; после сохранения
   сюжета — `ready` и выпуск собирается; мутация «всегда ready» краснит тест),
   `apps/studio/test/control-errors.test.mjs` (9 тестов; мутация условия краснит),
   живой прогон CDP `step43/step44` — в панели «Проверка квеста» видно
   «Квест готов. Выпуск пока не собрать: У миссии нет сохранённой истории…»,
   консольных ошибок 0, скриншот `43-r01-notice.png`.

### R-02. Кнопка публикации была неотличима от отсутствующей (высокая, исправлено в этой сессии)

В интерфейсе мастерской не было слова «Опубликовать»: кнопка в списке выпусков
называлась `Publish report`, откат — `Rollback report`, а заголовок отчёта —
`Owner publish report: <id>`. Владелец искал публикацию и не находил её.

Исправлено: кнопки и отчёт переведены на русский («Опубликовать…», «Откатить…»,
«Публикация <id>»), и в верхней панели миссии добавлена точка входа
`renderPublishEntry` (в `versions.ts`, покрыта тестами `apps/studio/test/publish-entry.test.mjs`,
5 тестов, мутация «инвертировать выбор выпуска» краснит тест): если есть собранный,
но не опубликованный выпуск — прямая кнопка «Опубликовать» с его id; если публиковать
нечего — кнопка ведёт в историю версий и честно объясняет это в подсказке.

### R-03. Повтор доставки той же публикации после `aborted` (высокая, исправлено в `708bc31`)

Из отчёта FIN-04: если публикация упала до сдвига указателя, `settle` при старте
помечает операцию `aborted`; повтор ТОЙ ЖЕ доставки с тем же `idempotencyKey`
трактуется как `ready`, указатель сдвигается, а `commitPublicationOperation` на
состоянии `aborted` отвечает `not_pending` → `500 PUBLICATION_COMMIT_FAILED` при уже
сдвинутом указателе. Ретрай с новым ключом работает. Правка требуется в
`apps/server/src/control-server.ts` (`beginPublicationCandidate`) либо в
`packages/control/src/publication-store.ts` — оба файла сейчас в работе других зон,
внесение правки отложено до агрегации находок.

**Исправлено (в `packages/control/src/publication-store.ts`), воспроизведение получено
буквально — `500 PUBLICATION_COMMIT_FAILED`:**

Причина оказалась в магазине, а не в обработчике. `beginPublicationOperation` для уже
существующей операции с тем же `requestHash` отвечал `replay` независимо от состояния,
и сервер (ветка `begun.kind === "replay"` в `beginPublicationCandidate`,
`apps/server/src/control-server.ts`) считал такую операцию готовой к коммиту. Для
операции в состоянии `aborted` это неверно: отменённая попытка не сделала видимым
ничего, поэтому повтор того же запроса — перезапуск неслучившейся попытки.

Правка: и в `MemoryControlPublicationStore`, и в `SQLiteControlPublicationStore`
операция в состоянии `aborted` при совпадающем `requestHash` переводится обратно в
`pending` (кандидат тот же — его защищает `requestHash`) и возвращается как `pending`.
Схема БД не менялась (`CONTROL_SCHEMA_VERSION` не трогался), маршруты и коды ответов
не менялись.

Доказательство: `apps/server/test/fin02-publication-retry-after-abort.test.mjs`
(2 теста на реальном SQLite-хранилище: отклонённая CAS-проверка → повтор той же
доставки обязан довести публикацию до конца; повтор, отклонённый снова, не двигает
ни каталог, ни указатель).
Мутация: снятие правки даёт ровно исходный дефект —
`{"error":{"code":"PUBLICATION_COMMIT_FAILED"}}`, 1 pass / 1 fail; с правкой — 2/2.


### R-04. Мёртвая проверка «чужой цели деплоя» (высокая, исправлено)

Найдено ревьюером зоны инфраструктуры, проверено и воспроизведено оркестратором.

`apps/builder-runner/src/preview-deployment.ts`, конструктор `PreviewDeploymentAdapter`
(строка 103 до правки):

```ts
if (policy.target.repositoryId !== policy.target.repositoryId) {
  throw new PreviewDeploymentError("deployment_not_authorized", "target mismatch");
}
```

Тавтология: `x !== x` ложно всегда, поэтому проверка не срабатывала никогда, а код
`deployment_not_authorized` в этом месте был мёртвым. При этом `gh`-шлюз знает свой
репозиторий только для `run view` (`this.repositoryId = repositoryId`), а `dispatched`
и `listRuns` ходили по `policy.target.repositoryId` — рукописная политика с чужим
`repositoryId` уезжала в незапланированный репозиторий.

Исправлено:
1. Конструктор адаптера проверяет политику фабричным `createPreviewDeploymentPolicy`
   (пересборка/валидация) и отказывает, если `gateway.repositoryId` не совпадает с
   `policy.target.repositoryId` (`deployment_not_authorized`).
2. В `PreviewDeploymentGateway` добавлено поле `repositoryId`, `createGhPreviewDeploymentGateway`
   его объявляет, а `dispatchWorkflow` отказывает чужой цели до вызова `gh`.

Доказательство: `apps/builder-runner/test/preview-deployment.test.mjs`, тест
«B13.b2 adapter refuses a hand-assembled target and a foreign repository».
Мутация: возврат тавтологии на место → 4 pass / 1 fail; с правкой → 5 pass / 0 fail.

### R-05. Реестровые документы не охранялись `docs-check` (средняя, исправлено)

`scripts/docs-check.mjs` объявляет `required`-список «документов-навигаторов», но в нём
не было `docs/CAPABILITY-MATRIX.md`, `docs/FIN-CHECKLIST.md`, `docs/PLAN-FIN-RU.md` —
документы, объявляющие себя реестром и маршрутом состояния проекта, могли исчезнуть
молча. Доказательство: удаление `docs/FIN-CHECKLIST.md` при старом списке не меняло
код возврата; после добавления — `docs-check` падает (exit 1), с файлом — 0.

### R-06. Занятый слаг каталога обнаруживался только на коммите (критическая, исправлено)

Находка ревьюеров зон публикации и хода, проверена и воспроизведена оркестратором.

`beginPublicationOperation` принимал операцию с уже занятым `slug` (адресом миссии на
сайте), потому что уникальность слага проверялась только в `commitPublicationOperation`.
Между этими двумя моментами сервер успевал сдвинуть указатель релиза
(`publishControlRelease` → `pinRelease`), после чего коммит отвечал `slug_conflict`:
запись каталога не появлялась, но указатель уже указывал на новый выпуск, а операция
оставалась `pending`. Дальше её подхватывал `settleInterruptedPublications` при каждом
запуске сервера и снова падал на том же коммите — вечный цикл, а сайт продолжал
обслуживать старый выпуск из-под нового указателя.

Правка: проверка занятости слага перенесена в начало операции — и в
`MemoryControlPublicationStore`, и в `SQLiteControlPublicationStore` (тот же SQL-запрос
по `control_publication_records`, исключающий свою же миссию). Новый исход
`{ kind: "slug_conflict" }` поднят в `apps/server/src/control-server.ts`
(`PublicationStaging`, `beginPublicationCandidate`) и отдаётся автору как
`409 PUBLICATION_SLUG_CONFLICT` до сдвига указателя; коммитная ветка столкновения
теперь помечает операцию `aborted` (а не оставляет `pending`), поэтому startup-settle
больше не зацикливается, а гонка между началом и коммитом называет причину вслух.
Studio объясняет отказ действием автора (`control-errors.ts`). Схема БД не менялась.

Доказательство: `apps/server/test/fin02-publication-slug-conflict.test.mjs` (2 теста на
реальном SQLite-хранилище: чужая миссия с тем же слагом получает 409, её указатель
остаётся `null`, записи каталога нет, список ожидающих операций пуст; повторная
публикация своей же миссии конфликтом не считается).
Мутация: отключение предварительной проверки в SQLite-ветке → 1 pass / 1 fail, причём
падение ровно по существу дефекта — `actual: 'release-b'`, `expected: null` (указатель
второй миссии сдвинулся, каталог её не получил). С правкой — 2/2 pass.


## R-07 — `initialWorld` на границе HTTP: 500 вместо честного 4xx (исправлено)

Находка N2 сводного ревью (зона `packages/control/src/sqlite-store.ts` +
`packages/contracts/src/references.ts`), воспроизведена оркестратором лично на HEAD
`2c8112f`: `hasValidWorldStateReferences({})` бросает
`TypeError: Cannot read properties of undefined (reading 'map')`.

HTTP-половина: `POST /control/v1/projects/:projectId/quests/:questId/mission/sessions`
проверял только `isPlainObject(body.initialWorld)`, поэтому форма `{}` доходила до
`createMissionSession` и роняла обработчик: клиент получал
`500 CONTROL_INTERNAL_ERROR` на собственной ошибке ввода вместо 4xx.

Правка (`apps/server/src/control-server.ts`): на границе добавлена структурная
проверка `isWorldStateShape` — обязательные коллекции мира (`locations`, `entities`,
`resources`, `items`) должны быть массивами, а их элементы — записями с `id`.
Неполная форма отвергается `400 INVALID_MISSION_SESSION_REQUEST`; глубокая валидация
мира остаётся за хранилищем (правило границы: недоверенный ввод падает в 4xx, а не в 500).

Доказательство: `apps/server/test/fin-validate-initial-world-http.test.mjs` — живой
HTTP-сервер Control, четыре неполные формы мира получают `400`, корректный мир
по-прежнему создаёт сессию (`201`).
Мутация: снятие `|| !isWorldStateShape(...)` → тест краснеет ровно по дефекту
(`ожидался 400, получено 500 {"error":{"code":"CONTROL_INTERNAL_ERROR"}}`); после
отката — 1 pass / 0 fail.

Остаток (не входит в R-07, остаётся за хранилищем): `createMissionSession` в
`packages/control/src/sqlite-store.ts` всё ещё бросает вместо возврата
`{ kind: "invalid_request" }` — это исправляется в зоне хранилища.


## Волна 2 — приёмка и интеграция (HEAD e9a20f2)

Три ветки волны 2 смёржены в `feat/b13-acceptance-closure` без конфликтов: `50f2213` (fix/devserver-imports), `49f460c` (fix/player-turn-owner), `e9a20f2` (fix/player-client-revision).

| № | Дефект | Ветка/коммит | Проверка оркестратора |
|---|---|---|---|
| R-08 | dev-прокси Studio резал `/imports` общим лимитом 262144 Б → `413` на архивах > ~192 КиБ, хотя Control принимает до 8 МиБ | `fix/devserver-imports` / `34d2307` | SHA совпал, `tsc -b --force` = 0, `imports-proxy.test.mjs` 1/1 pass |
| R-09 | сервис хода не привязан к участнику: чужой игрок того же квеста читал и вёл чужую сессию по одному `sessionId` | `fix/player-turn-owner` / `ea09b17` | SHA совпал, тест 2/2; мутация (снятие сверки `actorUserId`) → 1 pass / 1 fail, откат → 2 pass / 0 fail |
| R-10 | клиент плеера принимал ответ с более старой `playerView.revision` (молчаливый откат) и непривязанный `presentation.frame` | `fix/player-client-revision` / `e7e10f4` | SHA совпал, `packages/player` 29/29, `apps/player` 23/23; мутация (снятие гвардов `STALE_PLAYER_VIEW`) → 3 pass / 3 fail, откат → 6 pass / 0 fail |

Полный прогон на смёрженном HEAD `e9a20f2`: `tsc -b --force` = 0; contracts 57, core 64, runtime 22, player 29, control 129, server 216 (215 pass, 1 skip), studio 236 (235 pass, 1 skip), apps/player 23, builder-runner 26 — суммарно 802 теста, 0 падений.

Открытая HTTP-половина R-09: маршруты `control-server.ts` зовут `applyMissionTurn` напрямую, минуя сервис с проверкой владельца. Проверка передана в финальную волну ревью `deleg_20ef1318` (8 ревьюеров, read-only, зоны: контракты+ядро, runtime+клиент плеера, хранилище/схема, публикация/релизы/пакеты, серверные границы, модули Studio, плеер+builder-runner+app.ts, скрипты+доки).

## Волна 1 — приёмка и интеграция восьми исправлений (HEAD 417893d)

Восемь листовых веток (диспетчер `deleg_165e5aac`, база `370b571`) смёржены в `feat/b13-acceptance-closure`:
`65aad0a` (contracts), `b1c17c7` (core), `5bc8429` (runtime), `4f2c977` (player), `acd060b` (server-resilience),
`804aed8` (anchors), `bb15992` (studio-board-svg), `417893d` (scripts).

| № | Дефект | Ветка / head_sha | Проверка |
|---|---|---|---|
| R-11 | `hasValidWorldStateReferences` бросал `TypeError` на `{}`/`null`; `validateMissionDraft` не проверял `choice.conditions`/`choice.effects` | `fix/contracts-worldstate` / `43dd626` | SHA совпал, tsc 0, contracts 68/68; мутации A/B ребёнка: 6 fail и 2 fail → откат зелёный |
| R-12 | отсутствие ключа `world.terminal` трактовалось как «история окончена» (`undefined !== null`) | `fix/core-terminal` / `d54fb5f` | SHA совпал, core 75/75; мутация: 9 fail из 11 → откат 11/11 |
| R-13 | рантайм принимал `WorldState` без `terminal` и без проверки формы; `projectPlayerView` падал `TypeError` | `fix/runtime-worldstate` / `ac7fe3b` | SHA совпал; **моя мутация на смёрженном HEAD**: снятие обоих guard'ов → runtime 27 pass / **4 fail**, откат → 31 pass / 0 fail, дерево чистое |
| R-14 | ход в `apps/player/app.js` не защищён от повторной отправки и устаревшего ответа; ответ сервера шёл в `innerHTML` без валидации/экранирования | `fix/player-turn` / `4f60583` | SHA совпал, app-player 28/28; 4 мутации ребёнка (снятие блокировки, валидации, `escapeHtml`) краснили набор |
| R-15 | `void advance()` в таймерах presence/editing-lock → unhandled rejection роняет сервер; `catch {}` в `handleAction` навсегда фиксировал ход `failed` при `SQLiteStorageBusyError` | `fix/server-resilience` / `8f0c6b6` | SHA совпал, server 219 (218 pass, 1 skip); мутации: 2 fail и `500 !== 503` → откат зелёный |
| R-16 | `anchorDeleted` всегда `true` для якорей `kind=layer`/`field` → UI рисовал «Элемент удалён» для существующего объекта | `fix/anchors-deleted` / `964ea5a` | SHA совпал, control 132/132; мутация ребёнка: 3/3 fail → откат 3/3 |
| R-17 | SVG связей доски двойное преобразование (`viewBox` со сдвигом pan при уже трансформированном `.story-world`); отдельный лимит прокси для `/imports` | `fix/studio-board-svg` / `8a58bfb` | SHA совпал, studio 239 (238 pass, 1 skip); **конфликт по `dev-server.ts` разрешён вручную** — оставлены одна константа `STUDIO_PROXY_IMPORT_BODY_LIMIT_BYTES = 64 МиБ` и сигнатура `proxyBodyLimit(pathname, importLimitBytes)`; оба теста волны 2 и задачи 7 зелёные (3/3) |
| R-18 | `check-boundaries.mjs` обходился динамическим `import()` и не читал вложенные каталоги; приёмочный drill `b13-b2` при `FAIL` возвращал exit 0 | `fix/scripts-guards` / `4c0345d` | SHA совпал, scripts 15/15; **моя мутация на смёрженном HEAD**: игнор dynamic-import → 7 pass / **3 fail**, откат → 15/15 |

Полный прогон на смёрженном HEAD `417893d`: `tsc -b --force` = 0; contracts 68, core 75, runtime 31, player 29,
control 132, server 219 (218 pass, 1 skip), studio 239 (238 pass, 1 skip), apps/player 28, builder-runner 26,
scripts 15 — **862 теста, 0 падений**; `check:boundaries` = ok (39 файлов); `docs:check` = ok.

Остаточные ограничения, названные исполнителями и принятые сознательно:
- R-16: scene-якорь без mission-документа всё ещё может считаться удалённым (булев тип и UI не поддерживают третье состояние).
- R-14: mock-стабы `client/executor` в тестовом стенде; живой браузерный прогон плеера не делался.
- R-12: `apps/server/src/player-turn.ts:241` содержит ту же проверку `terminal !== null` — вне зоны задачи, действителен.

## Волна 3 — приёмка и интеграция шести исправлений (HEAD `72d2137`)

Диспетчер `deleg_7c31d5a2` (6 листовых задач, база `2c8112f`, 37 минут). Все ветки сверены по SHA перед слиянием, каждая — свой worktree.

| № | Зона | Ветка / SHA | Что закрыто |
|---|---|---|---|
| R-19 | `packages/control/src/release-stores.ts` | `fix/release-replay-cas` / `685be02` | replay публикации/отката возвращал `currentReleaseId` на момент первого выполнения, не сверяя живой указатель: после publish-2 → rollback на release-1 повторная доставка того же Idempotency-Key отдавала `{kind:"replay", outcome:"published", currentReleaseId:"release-2"}`. Теперь расхождение даёт `current_release_conflict` (сервер отвечает 409), а не фальшивый успех. |
| R-20 | `packages/control/src/lhquest-package.ts` | `fix/lhquest-deepjson` / `974ceec` | пакет 40 КБ с ~20 000 уровней вложенности валил импорт `RangeError: Maximum call stack size exceeded` вместо `{kind:'invalid_package'}`. Добавлен `MAX_PACKAGE_JSON_DEPTH = 64`, итеративный зонд глубины, `containsForbiddenKey` на явном стеке и fail-closed `try/catch` вокруг разбора. |
| R-21 | `packages/ai/src/codex-app-server-backend.ts` | `fix/ai-codex-init-retry` / `2eb1583` | `#initializePromise` кэшировался навсегда: одна retryable-ошибка инициализации (timeout/rate_limited) воспроизводилась при каждом `openSession`. Теперь кэш сбрасывается, отказ помнится только до `retryAtMs` (для retryable с `retryAfterMs` — кулдаун, иначе повтор сразу), non-retryable остаётся fail-fast. |
| R-22 | `packages/control/src/author-agent-jobs.ts` | `fix/author-agent-result-kind-mismatch` / `7dcd4c4` | `completeOperation` принимал результат чужого вида: операцию `draft.read` можно было закрыть результатом `proposal_applied` и наоборот. Добавлена карта `OPERATION_RESULT_KIND` (read_blocks↔draft.read, proposal_previewed↔proposal.preview, proposal_applied↔proposal.apply, reference_read↔docs.reference.read), новый исход `result_kind_mismatch`, проверка до записи (в SQLite — с ROLLBACK), отвергается и противоречивая durable-запись. |
| R-23 | `apps/studio` (screen-dom, styles) | `fix/studio-svg-and-resize` / `4e871cb` | ручка resize сцены создавалась один раз и не скрывалась в ветке «нет выделения», оставались старые `left/top` последнего слоя; CSS не гасил `data-layer-id=""`. Добавлены `hidden`/`display:none`/очистка геометрии и правило `.screen-resize-handle[hidden], [data-layer-id=""]`. |
| R-24 | `apps/player/app.js` | `fix/player-app-turn-race` / `68332ae` | гонка хода и XSS — но эта ветка **пересекалась с уже влитым R-14**; см. ниже. |

### Пересечения с волной 1 и как они разрешены

1. **`apps/player/app.js` (R-24 поверх R-14).** Обе волны независимо чинили один дефект. Версия волны 3 полнее по постановке карточки N8: монотонный `ordinal` вместо счётчика-пары, при `409 TURN_CONFLICT` — не откат, а **пересинхронизация через `GET /player-turn.json?sessionId=`**, и полная валидация позиции в самом `app.js`. Версия волны 1 дополнительно привязывала ответ к серверной сессии (`sessionId`), чего в волне 3 не было.
   **Разрешение:** взята реализация волны 3 + мной возвращена привязка к сессии — `commitStoryTurn` фиксирует `sessionId` на момент отправки, поздний ответ применяется только если `ordinal` актуален **и** `storySessionId()` не сменилась, а `resetStorySession()` инкрементирует `ordinal` (гасит ход в полёте). Это не косметика: тест волны 1 «устаревший ответ предыдущей сессии не применяется» на чистой версии волны 3 **падал** (`turns` уезжал с `0` на `7`).
   Оба набора тестов сохранены: `apps/player/test/fin05-player-turn-race.test.mjs` (волна 3, 7 тестов) и `fin05-player-turn-race-r14.test.mjs` (волна 1, 5 тестов). Файл `fin05-player-turn-race-r14.test.mjs` создан именно потому, что ветки дали **одноимённые** файлы (add/add-конфликт).
2. **`apps/studio/src/story-dom.ts` (R-23 поверх R-17).** Обе ветки правили `paintEdges` и пришли к **идентичному коду** (`viewBox = 0 0 worldW worldH`, ширина/высота в world-пикселях); различались только комментарии. Оставлен вариант R-17 (комментарий полнее), из R-23 взяты уникальные части — `screen-dom.ts` и `styles.css`.

### Проверено лично на смёрженном HEAD `72d2137`

`tsc -b --force` = 0; `check:boundaries` = ok (39 файлов); `docs:check` = ok.

contracts 68 · core 75 · runtime 31 · player 29 · ai 48 · control 141 · server 219 (218 pass, 1 skip) · studio 241 (240 pass, 1 skip) · apps/player 35 · builder-runner 26 · scripts 15 — **928 тестов, 0 падений**.

Мутации, снятые и откаченные мной на смёрженном дереве (все три покраснели, откат вернул зелёное, рабочее дерево чистое):

| Фикс | Что снято | Красное | После отката |
|---|---|---|---|
| R-19 | `if (current !== replay.releaseId)` → `false &&` (все 4 ветки: Memory/SQLite × publish/rollback) | `pass 0 / fail 2` | `pass 2 / fail 0` |
| R-20 | лимит глубины JSON отключён | `pass 1 / fail 3` | `pass 4 / fail 0` |
| R-21 | `retryAtMs` для retryable снова `null` (вечное кэширование) | `pass 46 / fail 2` | `pass 48 / fail 0` |

## Смок-прогон живого контура (`scripts/smoke.mjs`, `npm run smoke`)

Отдельный от модульных тестов быстрый приёмочный прогон: поднимает **реальный собранный сервер** (`apps/server/dist/main.js`) на временной SQLite-базе и проходит контур «автор → проверка → релиз → публикация → каталог → игра → перезапуск».

Зачем понадобился отдельный смок: тестовый харнесс поднимает сервер **без** `missionStore`, поэтому блок заморозки релиза в нём не выполняется. На реальном сервере путь публикации строже: релиз собирается только при наличии сохранённого документа миссии (`POST /control/v1/projects/:projectId/quests/:questId/mission`), а сам черновик квеста имеет **свою** ревизию. Модульные тесты этого расхождения не видят по построению — смок видит.

Шаги (18, все на живом HTTP, без единого мока):

| Раздел | Шаги |
|---|---|
| Готовность | S1 `GET /control/v1/projects` = 200 |
| Пустое состояние | S2 публичный каталог на свежей базе пуст |
| Автор | S3 проект 201 · S4 миссия 201 · S5 документ миссии сохранён (ревизия 1) · S6 проверка черновика `valid` 201 · S7 релиз 201 · S8 публикация 200 |
| Публикация | S9 указатель публикации смотрит на выпущенный релиз · S10 каталог видит миссию (1 запись, адрес `smoke-mission`) · S11 публичная карточка миссии 200 |
| Честность границ | S12 неизвестная миссия — 404 · S13 битый `initialWorld` — 422 `INVALID_PUBLIC_MISSION_SESSION_REQUEST` (не 500: это поведение R-07 на публичном контуре) |
| Игра | S14 сессия 201 · S15 состояние хода по credential 200, без credential 401 · S16 ход применяется и приводит к концовке `ending/done` · S17 повтор хода с тем же `baseTurn` — 409 `MISSION_TURN_CONFLICT` |
| Устойчивость | S18 публикация переживает перезапуск сервера (второй запуск на той же базе, каталог всё ещё видит миссию) |

Прогон: `PASS 18, SKIP 0, FAIL 0`, exit 0. Квитанция — `docs/worklog/smoke-receipt.json`.

**Проверка несущей способности смока (мутация):** в собранном `apps/server/dist/control-server.js` статус `MISSION_TURN_CONFLICT` заменён с 409 на 200 → `✖ S17 … status 200, MISSION_TURN_CONFLICT`, `SMOKE: FAIL — PASS 17, SKIP 0, FAIL 1`, exit 1; после возврата файла из копии — снова `PASS 18, exit 0`.

Смок намеренно **не** входит в `npm run verify`: он требует свободных портов и собранного `dist`, тогда как `verify` должен оставаться чисто модульным.

## Финальная волна ревью (`deleg_20ef1318`, 8 зон, read-only, база `e9a20f2`, сверка на `bbf8a70`) и исправления R-25…R-35

Волна шла, пока в ветку вливались волны 1–3, поэтому часть ревьюеров зафиксировала расхождение SHA и перепроверила находки на актуальном дереве. Ниже — только те находки, которые **воспроизводятся** (код + команда + вывод); стилистика не считается находкой.

| # | Находка | Зона | Статус |
| - | - | - | - |
| R-25 | Контрольные HTTP-маршруты сессии/хода не проверяли владельца: любой редактор проекта мог читать и вести чужую сессию хода (`actorUserId` не сверялся) — HIGH | apps/server | **исправлено** `2ce2d14`, тест `fin05-player-turn-owner-http.test.mjs` |
| R-26 | Мир без ключа `terminal` проходил границу (201), а проекция читала `world.terminal.outcome` напрямую → 500; испорченный `terminal` тоже оседал в сессии | apps/server | **исправлено** `2ce2d14`, там же |
| R-27 | Реальный код 401 `CONTROL_AUTH_REQUIRED` не переводился в действие; маппинг описывал коды, которых сервер не возвращает | apps/studio | **исправлено** `fb2cbf6` |
| R-28 | Идемпотентный повтор `unpublish` возвращал «успех» ДО CAS-проверки `expectedReleaseId` (оба хранилища) — HIGH | packages/control | **исправлено** `fb2cbf6`, тест `publication-unpublish-replay-cas.test.mjs` |
| R-29 | Описания карточек доски и сюжетных узлов обрезались `-webkit-line-clamp: 3` — прямое нарушение правила владельца (страж ловил только `text-overflow: ellipsis` в блоке FIN-12) | apps/studio | **исправлено** `9908863`, страж расширен на весь `styles.css` |
| R-30 | Пустой ответ с кодом 200 превращался в `null`, и вызывающий падал `TypeError` вместо понятной ошибки протокола | apps/studio | **исправлено** `9908863` (204/205 остаются законными) |
| R-31 | `hasValidWorldStateReferences` не отвергал `null` в `locations`/`resources` → `TypeError` в условиях/эффектах | packages/contracts | в работе |
| R-32 | Дублирование сцены/выбора в Studio жёстко писало `conditions: []`/`effects: []` — потеря авторских данных | apps/studio | в работе |
| R-33 | `anchorDeleted` считался без учёта `kind`: все диалоги layer/field помечались «элемент удалён», а совпавший id блока оживлял чужой якорь | packages/control | в работе |
| R-34 | `hashMissionSessionRequest` не включал `actorUserId`: чужой участник с той же парой (sessionId, idempotencyKey) получал чужую сессию как replay | packages/control | в работе |
| R-35 | `l07-cdp.mjs` заявлял `fill`/`key`, молча их выбрасывал и всегда выходил с кодом 0 | scripts | в работе |

Зона 1 дополнительно нашла противоречие: ядро считает мир без `terminal` активным, а гейты игрового времени (`scheduler.ts`, `scheduler-process.ts`) проверяли `state.terminal !== null` — то есть «активный» мир был навсегда заморожен для времени. Это устранено ветвью рефакторинга `refactor/core-terminal-paths` (гейты переведены на `missionTerminalStatus`); приёмка — при слиянии волны рефакторинга.

### Мутационные доказательства исправлений R-25…R-30

| Фикс | Мутация | Результат |
| - | - | - |
| R-25 | владелец снят и на GET сессии, и на POST хода (`else if (false)`, `if (false)`) | `✖ fail 1` из 2 → откат → `2/2 pass` |
| R-26 | проекция снова читает `session.world.terminal.outcome` напрямую; граница перестаёт проверять форму `terminal` | `✖ fail 1` (в двух независимых прогонах) → откат → `2/2 pass` |
| R-28 | идемпотентный повтор возвращён выше CAS в ОБОИХ хранилищах | `tests 4 / pass 2 / fail 2` → откат → `4/4 pass` |
| R-29 | возврат `-webkit-line-clamp: 3` в `.node-desc` | страж краснеет (правило владельца) |
| R-30 | `parseJson` снова отдаёт `null` на пустом теле 200 | `tests 5 / pass 4 / fail 1` → откат → `5/5 pass` |

Отдельно зафиксирован урок: **восстанавливать файлы после мутации только из cp-бэкапа**. Попытка восстановления через `git checkout --` в этом прогоне уничтожила незакоммиченные фиксы R-25/R-26 (они были восстановлены заново и закоммичены). Мутационные скрипты также обязаны проверять факт мутации и код сборки: при `TSC!=0` прогон невалиден (тесты видят старый `dist`).

## Приёмка волны рефакторинга (8 зон) и личные мутации на смёрженном HEAD

Все 8 веток рефакторинга влиты в `feat/b13-acceptance-closure` **без конфликтов**: `refactor/contracts-primitives` (`3d63a1b`), `refactor/core-terminal-paths` (`1cd988f`), `refactor/control-json-primitives` (`eadda28`), `refactor/runtime-shared` (`178874b`), `refactor/server-http-primitives` (`59a01ca`), `refactor/player-guards` (`7139a52`), `refactor/scripts-drill-harness` (`f3737a2`), `refactor/studio-dom-helpers` (`881af78`). Итоговый SHA приёмки: `63dd706`.

Прогон на `63dd706`: `tsc -b --force` = 0; contracts 77, core 81, runtime 56, player-pkg 29, ai 48, control 160, server 238 (237 + 1 skip), studio 251 (250 + 1 skip), apps/player 40, builder-runner 26, scripts 27 → **1033 теста, 0 падений**; `check:boundaries` ok; `docs:check` ok. До рефакторинга было 928 тестов.

Личные мутации по одной на зону (сборка → красный прогон → откат из cp-бэкапа → зелёный):

| # | Зона | Мутация | Результат |
|---|---|---|---|
| M1 | contracts | `hasOnlyKeys` → `return true` | `77 / pass 66 / fail 11` → откат → `77/77` |
| M2 | core | гейт терминала в `scheduler.ts` возвращён к `state.terminal !== null` | `81 / pass 78 / fail 3` → откат → `81/81` |
| M3 | server | `sendNotFound` отдаёт 200 вместо 404 | `238 / pass 233 / fail 4` → откат → `237 pass, 1 skip, 0 fail` |
| M4 | runtime | `isSafeNonNegativeInteger` без `Number.isSafeInteger` | `56 / pass 55 / fail 1` → откат → `56/56` |
| M5 | scripts | `exitCodeForResult` всегда 0 | `27 / pass 23 / fail 4` → откат → `27/27` |
| M6 | control | `isHash` принимает любую строку | `160 / pass 159 / fail 1` → откат → `160/160` |
| M7 | apps/player | `escapeHtml` больше не экранирует `&` | `40 / pass 39 / fail 1` → откат → `40/40` |
| M8 | studio | `escapeHtml` без `&` и кавычек | `251 / pass 243 / fail 7` → откат → `250 pass, 1 skip, 0 fail` |

Финальное состояние дерева после приёмки: `HEAD=63dd706`, `git status` пуст.

Честные остатки рефакторинга (зафиксированы, намеренно не тронуты):
- `apps/studio/src/app.ts` и `apps/player/app.js` сохраняют собственные копии `escapeHtml`/`isId`/`isTurnPosition`. Для `app.js` вынос **заблокирован тестом** `apps/player/test/fin05-player-turn-race.test.mjs`: он вырезает из исходника все строки импорта и запрещает сам токен `import`, поэтому внешний импорт стражей ломает харнесс (`ReferenceError: isTurnPosition is not defined`). Разблокировка требует правки теста и не делалась.
- `apps/server/src/control-server.ts` (горячий файл) остаётся с 10 локальными копиями помощников (`readCookie`/`readJsonBody`/`readHeader`/`sendNotFound`/`sendJson`/`isPlainObject`/`hasExactKeys`/`isId`/`isTitle`/`isRevision`).
- Не слиты осознанно (разная семантика, снабжены комментариями): `result.isRecord` vs строгий plain-record; `isPositiveInteger`/`isNonNegativeInteger` vs `isSafeNonNegativeInteger`; `shortHash` 7 vs 8 символов; три семантики `parseJson` (байты-пакет / сырой SyntaxError / fail-closed `invalid stored JSON`); `parseJsonColumn` vs `playtest-trace.parseJson`; `nextFencingToken` memory vs sqlite; проекции строк операций.
