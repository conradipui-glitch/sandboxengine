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

- `dice-check@1.0.0` — capabilities: dice-check.capability.skill-check; actions: dice-check.action.skill-check; recipes: dice-check.recipe.skill-check

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
- `POST /control/v1/auth/login` — Вход закрытого Control-пользователя и выдача серверной сессии с CSRF proof
- `GET /control/v1/auth/session` — Получение безопасных метаданных текущей Control-сессии
- `POST /control/v1/auth/logout` — CSRF-защищённый отзыв текущей Control-сессии
- `GET /control/v1/projects` — Список доступных текущему автору проектов
- `POST /control/v1/projects` — Создание авторского проекта; в authenticated mode создатель атомарно становится owner
- `GET /control/v1/projects/{projectId}/members` — Owner-only список участников проекта и ролей
- `PUT /control/v1/projects/{projectId}/members/{userId}` — Owner-only назначение роли owner/editor/tester существующему закрытому пользователю
- `DELETE /control/v1/projects/{projectId}/members/{userId}` — Owner-only удаление участника с защитой последнего owner
- `GET /control/v1/projects/{projectId}/quests` — Список квестов доступного проекта и текущих draft revisions
- `POST /control/v1/projects/{projectId}/quests` — Owner/editor создание квеста с начальным draft snapshot
- `GET /control/v1/projects/{projectId}/quests/{questId}/draft` — Получение текущего авторского draft snapshot доступного проекта
- `POST /control/v1/projects/{projectId}/quests/{questId}/draft/changes` — Owner/editor атомарное применение change set к указанной draft revision
- `GET /control/v1/projects/{projectId}/quests/{questId}/draft/history` — Постраничная история immutable draft revisions доступного проекта
- `GET /control/v1/projects/{projectId}/quests/{questId}/draft/compare` — Серверное сравнение двух конкретных draft revisions без автоматического merge
- `GET /control/v1/projects/{projectId}/quests/{questId}/draft/references` — Typed preflight зависимостей блока и объяснение безопасности удаления
- `POST /control/v1/projects/{projectId}/quests/{questId}/draft/restore` — Owner/editor idempotent восстановление прошлой revision как новой revision по baseRevision CAS
- `POST /control/v1/projects/{projectId}/quests/{sourceQuestId}/clone` — Owner/editor idempotent clone текущего source draft в независимый quest с remap внутренних block IDs
- `GET /control/v1/projects/{projectId}/quests/{questId}/export` — Owner/editor экспорт точной immutable draft revision или exact immutable release как deterministic inert .lhquest.zip package
- `POST /control/v1/projects/{projectId}/imports` — Owner/editor bounded fail-closed import .lhquest.zip в новый unpublished quest draft
- `POST /control/v1/projects/{projectId}/quests/{questId}/validations` — Проверка конкретной draft revision участником проекта и фиксация immutable report
- `POST /control/v1/projects/{projectId}/quests/{questId}/playtests` — Создание frozen playtest участником проекта из проверенного draft snapshot
- `GET /control/v1/projects/{projectId}/quests/{questId}/playtests/{playtestId}` — Чтение безопасных метаданных frozen playtest доступного проекта
- `GET /control/v1/projects/{projectId}/quests/{questId}/playtests/{playtestId}/trace` — Чтение bounded persisted Runtime evidence для exact frozen playtest без replay gameplay и без guest credential/idempotency/fencing данных
- `GET /control/v1/projects/{projectId}/quests/{questId}/releases` — Чтение immutable release summaries, current pointer и publication status участником проекта
- `POST /control/v1/projects/{projectId}/quests/{questId}/releases` — Owner/editor сборка immutable release из точной успешной validation и compiled artifact hash
- `POST /control/v1/projects/{projectId}/quests/{questId}/publish` — Owner-only атомарная публикация совместимого release через expected-current compare-and-set
- `POST /control/v1/projects/{projectId}/quests/{questId}/rollback` — Owner-only pointer rollback к ранее опубликованному release через expected-current compare-and-set
- `POST /control/v1/projects/{projectId}/quests/{questId}/draft/proposals/preview` — Owner/editor server-authoritative validate-on-copy preview typed AuthoringProposal against its exact immutable base revision without draft mutation
- `POST /control/v1/projects/{projectId}/quests/{questId}/draft/proposals/apply` — Owner/editor CSRF/idempotency protected atomic apply of a typed AuthoringProposal only when exact base revision/hash is still current
- `GET /control/v1/projects/{projectId}/quests/{questId}/author/jobs` — Owner/editor discovery of their durable author jobs for one exact project and quest
- `POST /control/v1/projects/{projectId}/quests/{questId}/author/jobs` — Owner/editor CSRF/idempotency protected creation of a bounded durable author job pinned to the current draft snapshot
- `GET /control/v1/projects/{projectId}/quests/{questId}/author/jobs/{jobId}` — Owner/editor read of their persisted author job, factual checkpoints, conversation and durable proposal artifacts
- `POST /control/v1/projects/{projectId}/quests/{questId}/author/jobs/{jobId}/segments` — Owner/editor CSRF/idempotency protected bounded author segment execution with durable replay, pause/resume and no automatic draft mutation
- `POST /control/v1/projects/{projectId}/quests/{questId}/author/jobs/{jobId}/cancel` — Owner/editor cancellation of a durable author job including abort of the exact in-flight backend signal and rejection of late output
- `POST /control/v1/projects/{projectId}/quests/{questId}/author/jobs/{jobId}/proposals/{proposalId}/apply` — Owner/editor CSRF/idempotency protected apply of the exact server-persisted proposal artifact by jobId and proposalId with durable applied checkpoint
- `GET /control/v1/agent-kit` — Authenticated read of the exact installed generated agent kit and compatibility identity used for write handshake

Trusted plugin metadata is build-time registry data only; this Skill does not imply dynamic plugin loading or resolver execution. Planned registry entries are intentionally excluded from the available list. Read ../../AGENTS.md, ../STATUS.md and ../HANDOFF.md before changing code.
