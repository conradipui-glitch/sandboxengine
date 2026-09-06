# Статус движка

Последнее обновление: 2026-09-06. Источник краткого статуса — этот файл; подробности и решения находятся по ссылкам.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий и навигация | **B01–B04 опубликованы; B05-01 accepted на PR #15** | B04 main `3ef8633cff0c07339e09107e4f3653f7e7295f0f`; B05-01 финальный docs gate → merge → main CI |
| Контракты/Core | B01–B03 приняты | typed actions/effects/conditions/social semantics, deterministic scheduler/tasks/terminal/RNG/replay |
| Runtime storage/API | **B04 published** | Memory+SQLite idempotency/fencing, guest ownership, PlayerView, Runtime HTTP; T10–12/T15; ADR 0011–0013 |
| Authoring / Control | **B05-01 accepted на branch** | Memory+SQLite draft, validation, frozen playtest, loopback Control HTTP; ADR 0014 |
| Studio UI | не начато | B05-02 после публикации B05-01 |
| Player basic author path | не начато | B05-03 |
| Onboarding/help | не начато | B05-04 / T29 |
| AI-провайдеры/свободный ввод | не начато | B06 |
| Presentation/assets | не начато | B07 |
| Плагины | не начато | B08 |
| Полный auth/publish author cycle | не начато | B09 |
| Авторский AI helper | не начато | B10 |
| Миграция Florence | не начато | B11 |

## Опубликованная B04 база

Main merge: `3ef8633cff0c07339e09107e4f3653f7e7295f0f`.  
Push-to-main CI: `34039569962` — success.

B04 гарантирует durable gameplay operation lifecycle, crash/restart/fencing, guest ownership, deny-by-default PlayerView и explicit Runtime HTTP. Authoring не меняет эти semantics.

## B05 — первый законченный путь автора

Canonical итог B05: человек без ручного JSON создаёт квест, добавляет ресурс, меняет стоимость действия, запускает новую тестовую сессию и видит новый результат; старый playtest остаётся на старых правилах.

Разбиение:

- B05-01 — draft/control/validation/frozen playtest;
- B05-02 — минимальные Studio forms;
- B05-03 — basic Player + frozen playtest E2E;
- B05-04 — help/onboarding/T29.

## B05-01 — accepted на PR #15

Карточка: [B05-01](tasks/B05-01-draft-control-frozen-playtest.md).  
Решение: [ADR 0014](decisions/0014-authoring-draft-frozen-playtest-control-boundary.md).

Принято:

- отдельный `@living-history/control`;
- bounded `core.action` для `core.paint`;
- `draftRevision` отдельно от `WorldState.revision` и Runtime fencing;
- atomic change set по `baseRevision`;
- exact revision/contentHash validation;
- immutable frozen playtest;
- Memory reference + durable `SQLiteControlStore` на отдельных `control_*` tables;
- reopen/restart и two-instance stale-writer regressions;
- loopback-only Control HTTP;
- 8 реально работающих Control operations;
- generated registry: всего 13 available operations / 11 distinct paths;
- `control.capabilities` и `control.agent-kit` остаются planned;
- registry hash `86d93105859f7c812f5d7e9f667a4d9bb3b01c2ab726fffd941b965197d97889`.

CI checkpoints:

- `34040472362` — semantic foundation success;
- `34046137073` — durable SQLite success;
- `34046356282` — Control HTTP success;
- `34046749725` — registry/generated contract success.

Матрица последнего publication-contract gate:

- contracts 37/37;
- Core 55/55;
- Runtime storage 20/20;
- Control 14/14;
- server 10/10;
- boundaries/docs green.

До merge PR #15 и зелёного push-to-main B05-01 считать accepted, но ещё не published.

## Следующий блок после publication

[B05-02 — Minimal Studio forms поверх Control API](tasks/B05-02-minimal-studio-forms.md).

Studio обязана быть клиентом Control API: project/quest/resource/paint forms, save by baseRevision, conflict UX, validation; никаких прямых SQLite/JSON writes.

## Scope boundary

Пока не реализованы Studio UI, Player E2E, onboarding, LLM/author helper, assets/presentation composer, roles/login/publish, animation suggestions и Florence migration.

Известное наблюдение CI: `npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high); force-upgrade без отдельного аудита не выполнялся.
