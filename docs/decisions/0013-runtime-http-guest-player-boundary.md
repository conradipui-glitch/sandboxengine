# ADR 0013 — Runtime HTTP, guest ownership и player-safe boundary

Статус: accepted для B04-03 после functional/hardening gates; публикация требует финального PR gate, merge и push-CI `main`.

## Контекст

B04-01 закрепил transport-agnostic `RuntimeStorage`, idempotency, lease и fencing semantics. B04-02 воспроизвёл их durable через SQLite. Последний слой B04 должен дать минимальный публичный Runtime API, не перенося игровую причинность из Core в HTTP и не раскрывая authoritative/private state клиенту.

## Решение

### 1. HTTP — только transport boundary

`apps/server`:

- аутентифицирует гостя;
- валидирует transport body/headers/size/content type;
- вычисляет canonical SHA-256 identity запроса server-side;
- вызывает существующий `RuntimeStorage.claimOperation`;
- выполняет только уже зарегистрированный explicit Core path после успешного claim;
- commit выполняет через существующий storage contract;
- возвращает сохранённый public response.

HTTP не меняет `WorldState` напрямую и не создаёт собственную idempotency/fencing state machine.

### 2. Guest ownership отделён от игрового состояния

Opaque credential выдаётся один раз при создании guest session. В durable storage хранится SHA-256 verifier в отдельной access table. Credential/verifier не входят в `WorldState`, TurnRecord или PlayerView.

Чужой или отсутствующий credential получает non-disclosing `404` для приватной session/operation boundary. Ownership проверяется до чтения или mutation.

### 3. PlayerView строится deny-by-default

`PlayerView` — новый объект по explicit allowlist, не cast/alias `WorldState`.

Не публикуются:

- resource min/max и другие неразрешённые internal поля;
- active operation internals;
- lease/service clock;
- fencing token/counter;
- request hash/idempotency internals;
- DB schema/errors/stacks;
- hidden/future state;
- provider secrets.

### 4. Public operation recovery ограничен

Operation endpoint возвращает только public operation ID, публичный status и persisted public response. Lease/fencing/request hash остаются private. Canonical recovery processing operation — повтор исходного action request с тем же idempotency key.

### 5. Endpoint readiness публикуется только после tests

Available registry содержит только реально реализованные операции:

- `GET /healthz`;
- `POST /v1/sessions`;
- `GET /v1/sessions/{sessionId}`;
- `POST /v1/sessions/{sessionId}/actions`;
- `GET /v1/sessions/{sessionId}/operations/{operationId}`.

`/v1/quests` и Control API остаются `planned`.

B04-03 task-card упоминал `/v1/health`; сохраняется ранее зарегистрированный B01 route `/healthz`, чтобы не вводить второй health contract без необходимости.

Registry теперь хранит `successStatus` для available operations, поэтому generated OpenAPI честно публикует `201` для session creation вместо универсального `200`.

### 6. Первый action path остаётся bounded

HTTP принимает только реально реализованный explicit `core.paint`. Free-text intent/narrator/provider относятся к B06 и в B04 не входят.

### 7. Storage busy не запускает Core повторно

Real SQLite lock отображается как `503 STORAGE_BUSY`. Claim не считается успешным, partial operation/state не публикуются, Core не вызывается.

## Доказательства

B04-03 server regressions включают:

- T15 deny-by-default PlayerView и cross-owner denial;
- committed retry возвращает byte-equivalent persisted payload, Core execution count остаётся 1;
- idempotency reuse/revision/action-in-progress mapping;
- malformed/oversize/unsupported input не создаёт operation/state transition;
- cross-owner mutation denial;
- guest verifier hash-at-rest;
- public operation projection без fencing/lease/request hash;
- restart сохраняет guest ownership и persisted replay;
- real SQLite lock → HTTP 503 без Core/partial operation.

Functional/hardening CI: `34038239722` — success. Publication registry/generated-doc gate: `34039363270` — success.

## Последствия

- Core остаётся authoritative для игровой причинности.
- Runtime storage остаётся authoritative для operation ownership/idempotency/fencing.
- HTTP может быть заменён другим transport без изменения Core/storage semantics.
- Player API не является debug/raw-state API.
- Следующие блоки не должны расширять Runtime через обход этих boundaries; новые публичные endpoints сначала реализуются и тестируются, затем переводятся в registry `available`.
