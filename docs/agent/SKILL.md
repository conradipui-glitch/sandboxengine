# Living History Engine — agent contract

Generated file. Do not edit by hand.

- Engine version: `0.1.0`
- Contracts schema version: `1.0`
- Canonical schemas: [schema-index.json](schema-index.json)
- Machine capabilities: [capabilities.json](capabilities.json)
- OpenAPI of implemented operations only: [api.openapi.json](api.openapi.json)

## Available block kinds

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

## Available HTTP operations

- `GET /healthz` — Проверка доступности Runtime API
- `POST /v1/sessions` — Создание гостевой игровой сессии
- `GET /v1/sessions/{sessionId}` — Получение player-safe состояния своей игровой сессии
- `POST /v1/sessions/{sessionId}/actions` — Отправка одного поддержанного explicit игрового действия
- `GET /v1/sessions/{sessionId}/operations/{operationId}` — Восстановление публичного статуса или результата операции

Planned registry entries are intentionally excluded from the available list. Read ../../AGENTS.md, ../STATUS.md and ../HANDOFF.md before changing code.
