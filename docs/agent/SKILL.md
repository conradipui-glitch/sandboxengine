# Living History Engine — agent contract

Generated file. Do not edit by hand.

- Engine version: `0.1.0`
- Core contracts schema version: `1.0`
- Presentation schema version: `2.0`
- Plugin manifest schema version: `1.0`
- Engine plugin API version: `1.0.0`
- Canonical schemas: [schema-index.json](schema-index.json)
- Machine capabilities: [capabilities.json](capabilities.json)
- OpenAPI of implemented operations only: [api.openapi.json](api.openapi.json)

## Installed trusted plugins

- Нет установленных trusted plugins в этой сборке.

## Available block kinds

- `core.action`
- `core.character`
- `core.location`
- `core.resource`

## Available gameplay effects

- `entity.move`
- `item.transfer`
- `resource.change`

## Available conditions

- `all`
- `any`
- `entity.at`
- `item.heldBy`
- `not`
- `resource.atLeast`

## Available social acts

- `permission`
- `request`
- `response`

## Available scheduled events

- `core.effects`
- `core.marker`
- `core.terminal`

## Available scheduled tasks

- `core.task`

## Available calculated actions

- `core.paint`
- `core.social.permission`
- `core.social.request`
- `core.social.response`

## Available presentation commands

- `actor.expression`
- `actor.hide`
- `actor.move`
- `actor.show`
- `audio.play`
- `audio.stop`
- `background.set`
- `dialogue.show`
- `item.show`
- `overlay.close`
- `overlay.open`
- `wait`

## Available HTTP operations

- `GET /healthz` — Проверка доступности Runtime API
- `POST /v1/sessions` — Создание гостевой игровой сессии
- `GET /v1/sessions/{sessionId}` — Получение player-safe состояния своей игровой сессии
- `POST /v1/sessions/{sessionId}/actions` — Отправка одного поддержанного explicit игрового действия
- `GET /v1/sessions/{sessionId}/operations/{operationId}` — Восстановление публичного статуса или результата операции
- `GET /control/v1/projects` — Список локальных авторских проектов
- `POST /control/v1/projects` — Создание локального авторского проекта
- `GET /control/v1/projects/{projectId}/quests` — Список квестов проекта и текущих draft revisions
- `POST /control/v1/projects/{projectId}/quests` — Создание квеста с начальным draft snapshot
- `GET /control/v1/projects/{projectId}/quests/{questId}/draft` — Получение текущего авторского draft snapshot
- `POST /control/v1/projects/{projectId}/quests/{questId}/draft/changes` — Атомарное применение change set к указанной draft revision
- `POST /control/v1/projects/{projectId}/quests/{questId}/validations` — Проверка конкретной draft revision и фиксация immutable report
- `POST /control/v1/projects/{projectId}/quests/{questId}/playtests` — Создание frozen playtest из проверенного draft snapshot

Trusted plugin metadata is build-time registry data only; this Skill does not imply dynamic plugin loading or resolver execution. Planned registry entries are intentionally excluded from the available list. Read ../../AGENTS.md, ../STATUS.md and ../HANDOFF.md before changing code.
