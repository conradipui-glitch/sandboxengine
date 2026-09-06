# B04-02 — SQLite transaction, restart и fault recovery

## Цель

Перенести уже принятую B04-01 `RuntimeStorage` semantics из Memory в один durable SQLite adapter и доказать T10–12 при restart/crash. Не добавлять HTTP/auth/PlayerView и не менять B03 Core.

## Вход

- B03 accepted/published;
- B04-01 `RuntimeStorage`, Memory reference semantics и ADR 0011;
- `docs/SPECIFICATION.md` §8, B04, T10–12.

## Сделать

### 1. Один SQLite adapter

Добавить `SQLiteRuntimeStorage`, реализующий **тот же** `RuntimeStorage` contract. Не создавать второй несовместимый operation lifecycle.

Минимальная DB schema должна хранить достаточно для:

- pinned session release identity + authoritative WorldState snapshot/revision;
- one `activeOperationId` и monotonic fencing counter;
- operations с unique `(sessionId, idempotencyKey)`, canonical request hash, expected revision, status, lease expiry, fencing token и persisted public response;
- immutable turn records.

Schema migrations имеют явный номер. Не создавать полный authoring/project schema B09 раньше времени.

### 2. Atomic claim/reacquire/commit

SQLite transaction должна атомарно обеспечивать:

- same completed key/hash → replay persisted response;
- same key/different hash or base revision → reuse conflict;
- одна active operation;
- monotonic fencing token;
- expired same request reacquire → token N+1;
- commit проверяет expected revision + active operation + current unexpired token;
- state snapshot + revision + turn + public response + operation completion + clear active owner сохраняются одной transaction;
- failed commit не оставляет частичной записи.

Не держать write transaction открытой вокруг Core/будущего LLM.

### 3. Service time и SQLite busy

Lease использует `ServiceClock`, а не game clock.

`SQLITE_BUSY`/lock contention обрабатывается короткой bounded policy на storage layer. Нельзя заново выполнять Core transition из-за busy.

### 4. Shared semantic suite

Выделить общие storage contract tests так, чтобы одинаковые T10/T11/basic fencing cases запускались и для Memory, и для SQLite adapter. Различие adapter не должно давать разные domain outcomes.

### 5. Durable T10 / lost response

Сценарий:

1. claim;
2. commit turn в SQLite;
3. представить потерю HTTP-ответа/закрыть adapter;
4. открыть новую instance на той же DB;
5. same key/hash возвращает **тот же persisted public response**;
6. revision/turn/effect не удваиваются.

### 6. Durable T11 / independent handlers

Две независимые `SQLiteRuntimeStorage` instance на одной DB пытаются claim разные команды для одной session/revision. Ровно одна получает ownership; другая получает conflict/in-progress. После commit нет lost update.

### 7. Durable T12 / crash + stale worker

Проверить отдельно:

- process dies after claim but before commit → world state/revision unchanged;
- после lease expiry новая instance reacquire same request с большим fencing token;
- старая instance/token после этого не может commit;
- current token commit succeeds once;
- process dies after commit / response lost → restart replay recovers stored result.

### 8. Fault injection

Добавить контролируемые test fault points вокруг atomic commit/transaction boundaries. Не имитировать crash путём ручной порчи DB.

## Приёмка

- `npm ci` + `npm run verify`;
- `npm run test:storage` запускает Memory + SQLite semantic suites;
- restart/lost-response test реально закрывает и повторно открывает DB file;
- two independent adapter instances реально участвуют в T11;
- stale fencing token после restart отклонён;
- failed/faulted commit не меняет state/revision/turn/response частично;
- Core boundary остаётся чистой;
- no HTTP/Fastify/auth/PlayerView;
- docs/handoff current.

## Не делать

- Fastify/Runtime endpoints;
- guest tokens/cookies;
- public PlayerView projection/T15;
- Redis/queues/websocket;
- background simulation;
- несколько DB adapters «на будущее»;
- authoring drafts/releases publication database;
- изменение scheduler/action/effect semantics.

## После приёмки

Если SQLite T10–12/restart/fencing полностью зелёные — принять **B04-02**, merge в `main`, проверить push-CI и только затем открыть B04-03 для Runtime HTTP + guest ownership + player-safe projection/T15. Общий B04 остаётся open до B04-03 canonical audit.
