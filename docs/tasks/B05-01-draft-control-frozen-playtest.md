# B05-01 — Draft Control foundation и frozen playtest snapshot

## Цель

Начать canonical B05 «Первый законченный путь автора» с server-side authoring foundation: минимальный проект/квест, ревизионный draft, атомарные изменения блоков, validation конкретной revision и создание playtest из immutable snapshot.

Этот slice **не строит полный Studio UI**. Он создаёт единственный authoritative authoring path, через который B05-02 формы будут читать/менять draft без локального JSON как второй истины.

## Канонический вход

- B04 полностью published: merge `3ef8633cff0c07339e09107e4f3653f7e7295f0f`, push-CI `34039569962`;
- `docs/SPECIFICATION.md` B05;
- §6 блоки/ссылки/compileQuest;
- §11.3 optimistic draft revisions и validation UX semantics;
- §11.4 frozen playtest snapshot;
- §15.2 Control API;
- §16.1 validation/playtest относятся к конкретному snapshot/hash.

## Главный invariant

**Draft — единственная редактируемая истина автора.**

Клиент не сохраняет вторую самостоятельную копию квеста. Любое изменение:

1. указывает `baseRevision`;
2. проверяется сервером;
3. либо создаёт новую draft revision атомарно, либо не меняет draft;
4. возвращает новый snapshot/revision.

Validation и playtest всегда ссылаются на конкретную immutable revision/hash. Изменение draft после старта playtest не меняет уже созданный playtest.

## Сделать

### 1. Минимальный authoring domain

Добавить в Runtime/Control слой отдельные типы:

- `ProjectRecord`;
- `QuestDraftRecord`;
- `DraftSnapshot`;
- `DraftChangeSet`;
- `DraftValidationRecord`;
- `FrozenPlaytestRecord`.

Минимальные поля draft:

- `projectId`;
- `questId`;
- `draftRevision` — safe nonnegative integer;
- `title`;
- `blocks` — массив зарегистрированных authoring blocks;
- canonical `contentHash` snapshot;
- timestamps/service metadata только там, где нужны authoring records; они не входят в quest content hash.

Не добавлять произвольный `Record<string, any>` как authoring state.

### 2. Первый bounded block vocabulary

Для сквозного B05 пути достаточно реально поддержать формы/данные:

- `core.location`;
- `core.character`;
- `core.resource`;
- один bounded `core.action` для `core.paint` либо эквивалентное authoring definition, которое компилируется в уже существующий Core path.

Если текущий B01 `Block` schema ещё не содержит нужный `core.action`, расширение делать schema-first с явной версией/registration/tests; не хардкодить action definition только в Studio.

Не пытаться в B05-01 реализовать все виды блоков из §6.2.

### 3. Authoring storage contract

Добавить transport-agnostic contract и Memory reference implementation для:

- create/list project minimum;
- create/list quest minimum;
- get current draft;
- apply draft changes by `baseRevision`;
- get historical immutable snapshot by revision;
- save immutable validation record;
- create frozen playtest record pinned to snapshot/hash.

Допустимо начать с Memory adapter как semantic reference, если SQLite schema change вынесен в следующий bounded slice; но текущий B05 путь не должен смешивать authoring records с gameplay `RuntimeStorage` tables/operation lifecycle.

Если SQLite authoring persistence добавляется здесь, она обязана повторять Memory semantics и иметь restart regression.

### 4. Atomic draft changes

`DraftChangeSet` поддерживает bounded operations:

- add block;
- replace block by ID;
- remove block by ID только если semantic reference validation разрешает удаление;
- update quest title.

Весь change set применяется на trial snapshot. Любая ошибка:

- stale base revision;
- duplicate ID;
- unknown block kind;
- broken semantic reference;
- invalid schema;
- удаление используемого блока;

отклоняет **весь** change set без новой revision.

### 5. Validation конкретной revision

Validation:

- принимает `projectId/questId/draftRevision`;
- получает immutable snapshot;
- запускает schema + semantic checks и `compileQuest` там, где текущий bounded vocabulary уже компилируем;
- сохраняет immutable report с snapshot hash;
- не помечает новую revision валидной старым report.

Повтор validation одной revision может вернуть новый report record, но каждый record сохраняет точный hash/revision.

### 6. Frozen playtest snapshot

Create playtest:

- принимает конкретную draft revision;
- требует успешную validation именно этого snapshot/hash;
- сохраняет immutable compiled snapshot/release identity для тестовой сессии;
- новая draft revision после создания playtest никак не меняет его content hash/definitions.

B05-01 может ограничиться record/snapshot creation без полного браузерного Player. B05-03 подключит этот frozen snapshot к UI.

### 7. Минимальные Control endpoints

Реализовать только реально нужный subset §15.2, например:

- `POST /control/v1/projects`;
- `GET /control/v1/projects`;
- `POST /control/v1/projects/{projectId}/quests`;
- `GET /control/v1/projects/{projectId}/quests`;
- `GET /control/v1/projects/{projectId}/quests/{questId}/draft`;
- `POST .../draft/changes`;
- `POST .../validations`;
- `POST .../playtests`.

Control endpoints first release доступны только loopback-owner development policy из B04/SPEC. Не открывать сетевую authoring auth раньше B09.

Registry переводит endpoint в `available` только после server tests.

### 8. Concurrency / stale draft regression

Обязательный сценарий:

1. два клиента читают draft revision `R`;
2. A применяет change set → `R+1`;
3. B пытается применить свой change set с `baseRevision=R`;
4. получает `409 DRAFT_REVISION_CONFLICT` и текущую revision;
5. изменения B не появляются в draft.

### 9. Frozen playtest regression

Обязательный сценарий:

1. создать draft R с paint cost = 1;
2. validate R;
3. создать playtest P, pinned к R/hash H1;
4. изменить draft → R+1, paint cost = 2;
5. validate R+1;
6. P всё ещё содержит H1/cost 1;
7. новый playtest P2 содержит новый hash/cost 2.

Это ключевая B05 гарантия: «старый плейтест не меняется при редактировании draft».

## Приёмка B05-01

- `npm run verify` green;
- отдельные authoring/control tests входят в verify;
- draft revision monotonic;
- stale base revision не перетирает новый draft;
- invalid multi-change set не применяет половину изменений;
- validation привязана к точному revision/hash;
- frozen playtest остаётся неизменным после последующих draft edits;
- Control API не возвращает raw storage internals;
- authoring storage не меняет gameplay `WorldState`/RuntimeStorage semantics;
- registry рекламирует только реально реализованный Control subset;
- Core по-прежнему не импортирует Runtime/Control/Studio.

## Не делать

- полный Studio UI — B05-02;
- полный Player presentation interpreter — B05-03/B07;
- tutorial/help — отдельный B05 slice;
- LLM/author assistant — B06/B10;
- asset upload/presentation composer — B07;
- publish/release/rollback/roles/login — B09;
- animation suggestion assistant — будущий Studio/Presentation slice после базового author path;
- arbitrary JSON editor как основной интерфейс;
- сетевой public Control API без auth;
- Florence migration.

## Следующие bounded slices B05

- **B05-02:** `apps/studio` — квесты/сущности/action-rule forms, save/conflict/validation UI через Control API.
- **B05-03:** базовый `packages/player` + frozen playtest E2E: фон/текст/action button/result/reset.
- **B05-04:** постоянная справка и повторяемый onboarding tour, T29, без AI usage.

Общий B05 accepted только когда человек проходит canonical путь «создать квест → добавить ресурс → изменить стоимость действия → запустить новую тестовую сессию → увидеть новый результат» без ручного JSON, а старый playtest остаётся frozen.
