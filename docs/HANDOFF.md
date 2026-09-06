# Передача работы

Обновлено: 2026-09-06

Текущий блок: **B04-02 — SQLite transaction, restart и fault recovery**  
База ветки: опубликованный B04-01 merge `c6e63be1bf9ac1998270220c6f8820a006b5c3ac`  
Текущая ветка: `b04-02-sqlite-restart-fault-recovery`  
Functional code head до docs closure: `71022f71e70391ed3e40954f964449cf3417e847`  
Статус: **accepted bounded по code/semantic gate; PR #13 должен пройти финальный docs gate, merge и push-CI**

## Принятая база

B03 опубликован и не меняется в Runtime. B04-01 опубликован в `main`: merge `c6e63be1bf9ac1998270220c6f8820a006b5c3ac`, push-CI `34036478296` success.

`RuntimeStorage` уже определяет canonical idempotency/lease/fencing semantics. SQLite adapter обязан их воспроизводить, а не создавать второй operation lifecycle.

## Выполнено в B04-02

- Реализован `SQLiteRuntimeStorage` на built-in Node 24.19 `node:sqlite`; новый native npm driver не добавлялся.
- Schema version явная и минимальная: runtime metadata, sessions, operations, turns.
- Хранятся pinned release identity, authoritative state/revision, active operation, persistent fencing counter и operation counter.
- Unique `(session_id, idempotency_key)`.
- Claim/reacquire/renew/commit/finish используют короткие SQLite transactions; Core/LLM внутрь write transaction не вызываются.
- Success commit атомарно сохраняет state + revision + turn + public response + operation completion и освобождает active owner.
- Lost HTTP response моделируется настоящим close/reopen DB; same key/hash восстанавливает persisted response без второго turn/revision.
- T11 использует две независимые `SQLiteRuntimeStorage` instance на одном DB file.
- T12 fault injection падает непосредственно before COMMIT; SQLite rollback оставляет мир/turn/response неизменными.
- После restart и lease expiry same request reacquire получает greater fencing token; stale old token отклоняется.
- `finishWithoutTurn` fault before COMMIT также не оставляет partial публикацию.
- Реальный competing SQLite write lock проверяет bounded busy handling.
- Busy policy использует bounded `DatabaseSync.timeout`; busy не запускает Core повторно.
- Shared semantic suite выполняется и для Memory, и для SQLite.

## Проверено

Первый clean PR #13 gate: CI `34036777799` — success.

- contracts 35/35;
- Core 55/55;
- storage 20/20;
- boundaries passed;
- docs check passed.

Именованные durable tests:

1. T10 SQLite durable — commit → response lost → reopen → persisted identical replay, no duplicate revision/turn.
2. T11 SQLite durable — two independent adapter instances cannot own different commands on one revision.
3. T12 SQLite durable — crash before COMMIT rolls back; restart/reacquire gets higher token; old token stays stale; current token commits once.
4. `finishWithoutTurn` fault before COMMIT leaves operation/owner unchanged.
5. Real SQLite write lock produces bounded busy failure without partial operation.
6. Shared T10/T11/T12 foundation runs for Memory and SQLite with the same domain outcomes.

ADR: `docs/decisions/0012-sqlite-durable-runtime-storage.md`.  
Worklog: `docs/worklog/2026-09-06-b04-02.md`.

## Что B04-02 не делает

- HTTP endpoints;
- guest session ownership/auth;
- PlayerView/public projection/T15;
- free-text intent/narrator/provider calls;
- Studio/Control API;
- Florence migration;
- Redis/queues/WebSocket/background simulation.

Поэтому общий **B04 остаётся open**.

## Следующее действие

1. Финальный PR #13 gate уже вместе с ADR/STATUS/HANDOFF/B04-03 task-card.
2. При green — merge PR #13 с expected head SHA.
3. Проверить push-to-main CI на merge SHA.
4. Только после зелёного main создать новую ветку от этого merge для [B04-03 — Runtime HTTP, guest ownership и player-safe projection](tasks/B04-03-runtime-http-guest-player-projection.md).

## B04-03 bounded scope

B04-03 завершает общий B04 через публичную transport boundary:

- реальный Node server package в `apps/server`;
- health endpoint;
- guest session creation + server-side ownership check;
- owner-only session read;
- explicit-action endpoint с server-side request hash, `Idempotency-Key`, `expectedRevision` и существующим `RuntimeStorage` lifecycle;
- public operation status/recovery;
- deny-by-default `PlayerView`, не raw `WorldState`;
- transport mapping `RuntimeStorage` outcomes → HTTP statuses/codes;
- T15 projection/retry/ownership regression;
- canonical T10–12/T15 audit до объявления общего B04 accepted.

Свободный текст/LLM не реализовывать в B04-03: он относится к B06.

## Решения

- ADR 0010 — B03 scheduler/replay closure.
- ADR 0011 — operation idempotency/lease/fencing + Memory reference semantics.
- ADR 0012 — durable SQLite RuntimeStorage и bounded busy/fault/restart policy.

## Dependency observation

`npm ci` по-прежнему сообщает 2 vulnerabilities (1 moderate, 1 high). Force-upgrade не смешивать с B04 closure без отдельного change set.
