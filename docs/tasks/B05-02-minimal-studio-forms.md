# B05-02 — Minimal Studio forms поверх Control API

## Цель

Создать первый человеческий authoring UI в `apps/studio`, который работает **только через опубликованный B05-01 Control API** и не хранит самостоятельную копию quest JSON как вторую истину.

После этого slice автор без ручного JSON должен уметь:

1. увидеть/создать проект;
2. создать квест;
3. открыть текущий draft;
4. добавить целочисленный ресурс через форму;
5. добавить/редактировать bounded действие `core.paint`;
6. изменить стоимость действия;
7. сохранить через `baseRevision`;
8. запустить validation и увидеть понятный результат;
9. корректно обработать stale draft conflict.

Полный игровой Player и доказательство изменения игрового результата относятся к B05-03.

## Канонический вход

- B05-01 должен быть опубликован в `main` и иметь зелёный push-CI;
- ADR 0014;
- `docs/SPECIFICATION.md` B05, §6, §11.1–11.4, §15.2;
- generated `docs/agent/api.openapi.json` и `capabilities.json`.

## Главный invariant

**Studio — клиент Control API, не authoring database.**

- после загрузки authoritative snapshot приходит с сервера;
- save всегда отправляет `baseRevision`;
- successful save заменяет локальный view новым server snapshot;
- conflict не выполняет silent overwrite;
- reload восстанавливает данные из Control API;
- UI не записывает quest JSON напрямую в SQLite/файлы.

## Сделать

### 1. App boundary

Создать минимальный `apps/studio` без попытки построить окончательную дизайн-систему.

Допустим простой web stack, уже совместимый с репозиторием. Не добавлять тяжёлый framework только ради одного экрана без явной пользы.

Studio dev server должен обращаться к loopback Control API. Если нужен dev proxy/CORS adapter — он не расширяет сетевую доступность самого Control listener.

### 2. Проекты и квесты

Минимальные экраны/состояния:

- список проектов;
- создание проекта;
- список квестов проекта;
- создание квеста с человеческими полями title/id и начальной локацией;
- открытие текущего draft.

Technical ID может быть видим как secondary/advanced поле, но основной путь не должен выглядеть как редактирование внутренней БД.

### 3. Каталог блоков первого slice

Показать человеческие названия зарегистрированных типов:

- Локация — `core.location`;
- Персонаж — `core.character` (минимальная форма, если требуется для текущего contract);
- Ресурс — `core.resource`;
- Действие «Рисовать» — bounded `core.action/core.paint`.

Не показывать неизвестные/не реализованные types как рабочие.

### 4. Формы без raw JSON

Для ресурса:

- название;
- technical ID;
- unit;
- initial value;
- min/max.

Для `core.paint`:

- название;
- resource select из существующих resource blocks;
- resource units per unit;
- duration per unit;
- allow partial.

Форма собирает обычный `DraftChangeSet`, но пользователь не редактирует JSON вручную.

### 5. Save / conflict UX

При save:

- использовать текущий `draftRevision` как `baseRevision`;
- показывать saving/saved/error state;
- при `409 DRAFT_REVISION_CONFLICT` не повторять запрос автоматически;
- получить свежий draft и показать, что версия изменилась;
- предложить повторить локальное изменение после review либо отменить его.

Не реализовывать silent last-write-wins.

### 6. Validation UX

Кнопка «Проверить квест» запускает validation текущей server revision.

Показать:

- revision/hash;
- valid/invalid;
- человекочитаемые ошибки;
- связь отчёта с текущим draft.

Если draft изменился после validation, UI явно показывает, что старый отчёт относится к предыдущей revision.

### 7. Состояния интерфейса

Обязательные:

- loading;
- empty project/quest;
- saving;
- saved;
- validation success;
- validation errors;
- stale conflict;
- Control unavailable.

Не маскировать server errors фиктивным success.

### 8. Доступность и минимальная адаптивность

- keyboard usable forms;
- реальные labels;
- focus не теряется после save/error;
- ошибки связаны с соответствующей формой;
- рабочий viewport минимум 360 px без горизонтального разрушения основного author flow.

Полный визуальный polishing не является acceptance B05-02.

## Тесты

Минимальный browser/E2E сценарий на real loopback Control + SQLite:

1. открыть пустую Studio;
2. создать project/quest;
3. добавить resource;
4. добавить `core.paint` cost=1;
5. save → revision растёт;
6. validation valid;
7. изменить cost=2;
8. save → новая revision;
9. reload страницы → cost=2 приходит с сервера;
10. отдельно смоделировать external update и убедиться, что stale save показывает conflict, а не перетирает server draft.

При возможности этот сценарий должен войти в root `verify` как bounded Studio test. Если браузерная инфраструктура требует отдельной dependency/tooling change, она должна быть минимальной и зафиксированной.

## Приёмка B05-02

- автор выполняет путь project → quest → resource → paint action → cost edit без ручного JSON;
- UI читает/пишет только через Control API;
- reload не теряет authoring state;
- stale conflict не даёт lost update;
- validation явно привязана к revision/hash;
- нет фиктивных доступных block types;
- targeted tests + repository verify green;
- generated docs меняются только если реально меняется public capability/API.

## Не делать

- полный Player/playtest UI — B05-03;
- onboarding tour — B05-04;
- LLM/free text/author assistant — B06/B10;
- asset manager/presentation timeline — B07;
- plugins — B08;
- roles/login/network Control auth/publish/rollback — B09;
- node graph;
- arbitrary JSON editor как основной путь;
- animation suggestions;
- Florence migration.

## Следующий slice

B05-03 использует frozen playtest B05-01 и draft, созданный через Studio B05-02, чтобы доказать end-to-end: изменение cost 1 → 2 даёт другой игровой результат в новой тестовой сессии, а старый playtest остаётся на старых правилах.
