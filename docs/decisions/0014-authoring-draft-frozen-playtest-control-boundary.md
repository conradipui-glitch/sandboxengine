# ADR 0014 — Authoring draft, frozen playtest и loopback Control boundary

Дата: 2026-09-06  
Статус: accepted в B05-01

## Контекст

После B04 движок имеет durable gameplay Runtime, но авторский контент нельзя безопасно редактировать через `RuntimeStorage`: игровая revision, lease/fencing и авторская revision описывают разные процессы. B05 требует server-side draft, validation конкретного snapshot и playtest, который не меняется после дальнейших правок.

## Решение

### 1. Отдельная Control boundary

Authoring semantics находятся в `@living-history/control`, а не в `@living-history/runtime` и не в Core.

Core остаётся вычислительным слоем квеста. Runtime хранит и публикует игровые сессии. Control хранит редактируемые quest drafts, validation records и frozen playtests.

### 2. Три независимых lifecycle

Не смешивать:

- `draftRevision` — версия редактируемого авторского snapshot;
- `WorldState.revision` — версия уже зафиксированного игрового мира;
- Runtime operation lease/fencing — право конкретного worker опубликовать игровой переход.

Изменение одного счётчика не подразумевает изменение другого.

### 3. Draft — единственная редактируемая истина

`DraftChangeSet` всегда содержит `baseRevision`. Изменения строятся на trial snapshot и публикуются только целиком. При stale revision, broken reference или invalid block новая revision не появляется.

Memory adapter задаёт reference semantics. `SQLiteControlStore` обязан воспроизводить их durable и использует отдельные `control_*` таблицы, даже если лежит в том же SQLite-файле, что Runtime.

### 4. Validation принадлежит snapshot, не quest вообще

Validation record фиксирует `projectId`, `questId`, `draftRevision`, `contentHash`, status/errors и при success compiled artifact/hash.

Тип `DraftValidationRecord` — discriminated union: `valid` физически требует compiled artifact/hash; `invalid` физически не может их содержать.

Старый validation report нельзя использовать для новой revision с другим hash.

### 5. Playtest замораживается при создании

`FrozenPlaytestRecord` хранит immutable draft snapshot и compiled artifact/hash конкретной validation. После изменения draft старый playtest не читает current draft и не меняет правила задним числом.

Это основа будущего B05-03 Player: test session запускается из frozen snapshot, а не из «последней версии» квеста.

### 6. Control HTTP до auth — только loopback

B05-01 реализует минимальный Control HTTP subset отдельным listener внутри `apps/server`, но `listen()` отвергает non-loopback host. Runnable server жёстко использует `127.0.0.1` для Control.

До B09 это не публичный authoring API. Наличие OpenAPI operation означает «реально реализовано в локальном Control surface», а не «безопасно открывать в интернет».

HTTP projection validation/playtest не выдаёт compiled artifact целиком; Studio получает ID, revision/hash/status/errors и ссылки, необходимые для авторского потока.

## Последствия

Плюсы:

- Studio B05-02 не создаёт локальный JSON как вторую истину;
- stale writer получает конфликт вместо lost update;
- restart не теряет draft/validation/playtest;
- старые playtests воспроизводимы после новых edits;
- B04 gameplay operation state machine не загрязняется authoring CRUD;
- public readiness остаётся проверяемой registry/generated docs.

Цена:

- пока есть два HTTP listener: Runtime и loopback Control;
- полноценные owner/editor/tester права и network auth отложены до B09;
- B05-01 vocabulary намеренно ограничен `core.location`, `core.character`, `core.resource`, bounded `core.action/core.paint`.

## Проверки решения

- Memory/SQLite shared authoring semantics;
- SQLite reopen сохраняет draft/validation/frozen playtest;
- две SQLite instance не допускают stale overwrite;
- HTTP stale revision → 409;
- invalid change set → 422 без mutation;
- old validation не создаёт playtest нового snapshot;
- Control non-loopback bind отклоняется;
- generated registry рекламирует только implemented routes;
- Core boundary запрещает Runtime/Control imports.

## Не решено этим ADR

Studio UI, Player, onboarding, LLM, assets/presentation, publish/rollback, roles/login, public Control auth и Florence migration находятся в последующих блоках.
