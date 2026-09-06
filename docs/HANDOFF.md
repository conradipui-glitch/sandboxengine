# Передача работы

Обновлено: 2026-09-06

Текущий блок: **B05-01 — Draft Control foundation и frozen playtest snapshot**  
База: опубликованный B04 merge `3ef8633cff0c07339e09107e4f3653f7e7295f0f`  
Ветка: `b05-01-canonical-slice`  
PR: #15  
Статус: **B05-01 accepted по code/semantic/API/generated-contract gate; остаётся final docs gate → merge → push-CI main**

## Опубликованная база

B01–B04 published. B04 push-CI `34039569962` — success. Gameplay Runtime semantics не менялись в B05-01.

## Что реализовано в B05-01

### Authoring domain

- отдельный package `@living-history/control`;
- bounded schema-first `core.action` для существующего `core.paint`;
- semantic resource references;
- `DraftSnapshot`, atomic `DraftChangeSet`, exact validation records, frozen playtests;
- `DraftValidationRecord` — discriminated union: valid требует artifact/hash, invalid запрещает их.

### Revision/lifecycle boundary

Не смешивать:

- `draftRevision` — authoring content;
- `WorldState.revision` — gameplay state;
- Runtime fencing/lease — operation ownership.

### Storage

Memory reference semantics + durable `SQLiteControlStore`.

SQLite использует отдельные `control_*` tables. Candidate draft строится до write transaction; short `BEGIN IMMEDIATE` сравнивает current revision и публикует snapshot atomically.

Доказано:

- stale base revision не перезаписывает новый draft;
- invalid multi-change set не применяет ранние изменения;
- referenced resource нельзя удалить;
- validation pinned к exact revision/hash;
- playtest frozen после edit;
- restart сохраняет draft/validation/playtest;
- две SQLite instances отвергают stale writer.

### Control HTTP

Отдельный listener в `apps/server`, только loopback. Non-loopback bind отклоняется до появления B09 auth.

Available routes:

- `GET/POST /control/v1/projects`;
- `GET/POST /control/v1/projects/{projectId}/quests`;
- `GET /control/v1/projects/{projectId}/quests/{questId}/draft`;
- `POST .../draft/changes`;
- `POST .../validations`;
- `POST .../playtests`.

Validation/playtest transport не раскрывает internal compiled artifact/snapshot целиком.

### Registry/generated contract

13 available operations total: 5 Runtime + 8 Control, 11 distinct paths.

Остаются planned:

- `runtime.quests.list`;
- `control.capabilities`;
- `control.agent-kit`.

Registry hash:
`86d93105859f7c812f5d7e9f667a4d9bb3b01c2ab726fffd941b965197d97889`.

Generated-doc regression теперь сравнивает OpenAPI/capabilities с actual registry readiness вместо исторического hardcode «5 endpoints».

## CI evidence

- `34040472362` — Memory semantic foundation success.
- `34046137073` — durable SQLite success.
- `34046356282` — loopback Control HTTP success.
- `34046749725` — registry/generated contract success.

Последняя матрица:

- contracts 37/37;
- Core 55/55;
- Runtime storage 20/20;
- Control 14/14;
- server 10/10;
- boundaries green;
- docs green.

ADR: `docs/decisions/0014-authoring-draft-frozen-playtest-control-boundary.md`.  
Worklog: `docs/worklog/2026-09-06-b05-01.md`.

## Publication sequence

1. Финальный PR #15 CI на head вместе с ADR/STATUS/HANDOFF/worklog/B05-02 task-card.
2. Если green — merge PR #15 с expected head SHA.
3. Проверить push-to-main CI на merge SHA.
4. Только после зелёного main создать новую ветку от merge для B05-02.

## Следующая задача после публикации

[B05-02 — Minimal Studio forms поверх Control API](tasks/B05-02-minimal-studio-forms.md).

Первый Studio slice:

- project/quest screens;
- resource form;
- bounded `core.paint` form;
- save через `baseRevision`;
- stale conflict без silent overwrite;
- validation UI;
- reload из Control API;
- без ручного JSON.

## Не делать до публикации B05-01

- не начинать Studio code в PR #15;
- не добавлять Player/LLM/assets/auth/publish;
- не открывать Control listener наружу;
- не смешивать authoring tables с Runtime operation tables;
- не добавлять animation suggestion assistant;
- не менять B03/B04 gameplay semantics;
- не делать force dependency upgrade.

`npm ci` по-прежнему сообщает 2 vulnerabilities (1 moderate, 1 high); отдельный audit позже.
