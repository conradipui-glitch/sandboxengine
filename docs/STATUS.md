# Статус движка

Последнее обновление: 2026-09-06. Источник краткого статуса — этот файл; подробности и решения находятся по ссылкам.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий и навигация | **B01–B04 опубликованы** | B04 merge `3ef8633cff0c07339e09107e4f3653f7e7295f0f`, push-CI `34039569962` |
| Контракты/Core | B01–B03 приняты | typed actions/effects/conditions/social semantics, deterministic scheduler/tasks/terminal/RNG/replay |
| Runtime storage/API | **B04 published** | Memory+SQLite idempotency/fencing, guest ownership, PlayerView, explicit HTTP; T10–12/T15; ADR 0011–0013 |
| Authoring / Control | **B05-01 начат** | draft revision/change-set/validation/frozen-playtest foundation по новой task-card |
| Studio UI | не начато | B05-02 после B05-01 semantic gate |
| Player basic author path | не начато | B05-03 |
| Onboarding/help | не начато | B05-04 / T29 |
| AI-провайдеры/свободный ввод | не начато | B06 |
| Presentation/assets | не начато | B07 |
| Плагины | не начато | B08 |
| Полный auth/publish author cycle | не начато | B09 |
| Авторский AI helper | не начато | B10 |
| Миграция Florence | не начато | B11 |

## B04 — опубликованная Runtime база

Main merge: `3ef8633cff0c07339e09107e4f3653f7e7295f0f`.  
Push-to-main CI: `34039569962` — success.

Принято:

- B04-01 transport-agnostic `RuntimeStorage`, idempotency, lease, fencing, atomic commit;
- B04-02 durable SQLite restart/fault/busy semantics;
- B04-03 guest ownership, deny-by-default PlayerView, Runtime HTTP and operation recovery;
- completed retry never re-executes Core;
- credential verifier hash-at-rest;
- cross-owner read/mutation denied server-side;
- real SQLite busy → 503 without partial operation/Core execution;
- generated contract advertises only five implemented Runtime endpoints;
- T10, T11, T12, T15 green;
- Core boundaries clean.

## Canonical B05

`docs/SPECIFICATION.md` определяет B05 как **«Первый законченный путь автора»**.

Итог B05 должен доказать путь без ручного JSON:

1. создать квест;
2. добавить ресурс;
3. изменить стоимость действия;
4. запустить новую тестовую сессию;
5. увидеть новый игровой результат;
6. убедиться, что старый playtest не изменился после редактирования draft.

B05 намеренно разбит:

- B05-01 — server-side draft/control + validation + frozen playtest snapshot;
- B05-02 — минимальные Studio-формы;
- B05-03 — базовый Player/E2E/reset;
- B05-04 — help/onboarding/T29.

## Текущая точка — B05-01

Карточка: [B05-01 — Draft Control foundation и frozen playtest snapshot](tasks/B05-01-draft-control-frozen-playtest.md).

Главные invariants:

- draft — единственная редактируемая authoring truth;
- `draftRevision` monotonic;
- изменения используют `baseRevision`;
- change set применим только целиком;
- stale revision не перетирает новый draft;
- validation привязана к exact revision/hash;
- playtest pinned к immutable snapshot/hash;
- новый draft не меняет уже созданный playtest;
- authoring storage не меняет gameplay RuntimeStorage semantics.

До semantic gate B05-01 не публиковать Control endpoints как `available`.

## Scope boundary

В B05-01 не входят:

- Studio UI;
- полный Player presentation interpreter;
- onboarding UI;
- LLM/author helper;
- assets/presentation composer;
- publish/rollback/roles/login;
- animation suggestions;
- Florence migration.

Известное наблюдение CI: `npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high); force-upgrade без отдельного аудита не выполнялся.
