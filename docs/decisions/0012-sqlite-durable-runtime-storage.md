# ADR 0012 — durable RuntimeStorage на built-in Node SQLite

Статус: accepted для B04-02  
Дата: 2026-09-06

## Контекст

B04-01 зафиксировал transport-agnostic `RuntimeStorage` semantics в Memory, но не давал guarantees при restart/process loss. B04-02 должен доказать те же outcomes на постоянном хранилище, не меняя B03 Core и не добавляя HTTP.

Проект уже закреплён на Node 24.19.0. В этой версии встроенный `node:sqlite` доступен, `DatabaseSync` выполняет операции синхронно, поддерживает file-backed database и bounded busy `timeout` в миллисекундах. Поэтому отдельный native npm SQLite driver для первого server runtime не нужен.

## Решение

1. Первый durable adapter — `SQLiteRuntimeStorage` поверх built-in `node:sqlite` `DatabaseSync`.
2. DB schema минимальна для B04: `runtime_meta`, `sessions`, `operations`, `turns`. Drafts/projects/auth/publication не добавляются раньше своих блоков.
3. Schema version хранится явно (`runtime_meta.schema_version = 1`). Operation ID counter также хранится в DB, поэтому restart не сбрасывает идентичность операций.
4. Claim/reacquire/renew/commit/finish используют короткие `BEGIN IMMEDIATE` transactions. Core/AI никогда не вызываются внутри write transaction.
5. SQLite воспроизводит B04-01 contract: unique `(session,idempotencyKey)`, one active operation, canonical request hash, persisted expected revision, monotonic fencing counter/token и replayable public response.
6. `commitTurn` сохраняет session state/revision, immutable turn record, completed operation response и освобождение active owner в одной SQLite transaction.
7. Fault injection перед `COMMIT` используется только в tests и доказывает rollback уже выполненных SQL writes.
8. Lost response после успешного COMMIT проверяется реальным close/reopen DB и idempotent replay, без повторного Core execution.
9. Lease использует injected `ServiceClock`; game clock остаётся содержимым WorldState и не влияет на lease.
10. Busy policy ограничена adapter-level `DatabaseSync.timeout`. После этого SQLite возвращает lock error, который нормализуется в `SQLiteStorageBusyError`. Мы не добавляем второй внешний цикл и не повторяем Core transition из-за lock contention.
11. Shared adapter-neutral tests выполняются для Memory и SQLite, чтобы durable adapter не создавал вторую operation semantics.
12. Один file-backed SQLite рассчитан на один server process / локальный persistent disk первого выпуска. Horizontal multi-server storage — будущий другой adapter, не цель B04.

## Доказательства

PR #13 first functional CI `34036777799` — success:

- contract 35/35;
- Core 55/55;
- storage 20/20;
- boundaries passed;
- docs check passed.

Storage suite включает:

- Memory + SQLite shared T10/T11/T12 foundation;
- durable T10 lost-response replay после close/reopen;
- durable T11 через две независимые SQLite adapter instances;
- durable T12: fault before COMMIT → rollback, restart/reacquire → higher fencing token, stale token rejected, current commit succeeds;
- `finishWithoutTurn` fault rollback;
- настоящий competing SQLite write lock → bounded `SQLiteStorageBusyError` без partial operation.

## Граница

B04-02 не содержит Fastify/HTTP, guest auth/token, PlayerView/T15, Studio/Control API и не принимает общий B04. Следующий слой B04-03 отображает уже принятую Core+Storage semantics наружу безопасным Runtime API.
