# Передача работы

Обновлено: 2026-09-06

Текущий блок: **B04-01 — operation/storage contract и Memory reference semantics**  
База ветки: опубликованный B03 merge `acb61b75b7b1fbcf782d6451a52230402e1d158d`  
Текущая ветка: `b04-01-operation-storage-contracts`  
Functional head после canonical hash fix: `623ac02e8cb4b2ad2540d43356b63c6f90880ffc`  
Статус: **accepted bounded по code/semantic gate; PR #12 должен пройти финальный docs gate, merge и push-CI**

## Выполнено

- Создан реальный package `@living-history/runtime`.
- Добавлены storage domain types/result unions без HTTP-кодов.
- Добавлен единый `RuntimeStorage`: `loadSession`, `claimOperation`, `renewLease`, `commitTurn`, `finishWithoutTurn`, `getOperation`.
- Реализован `MemoryRuntimeStorage` как reference semantics для будущего SQLite.
- Unique `(sessionId, idempotencyKey)` и одна active operation на session.
- Request hash — canonical lowercase SHA-256; same hex в другом casing остаётся тем же запросом.
- Same completed key/hash возвращает persisted public response до current-revision conflict.
- Same key с другим hash или исходной revision → `idempotency_key_reused`.
- Lease использует injected `ServiceClock`, не игровой `WorldState.clock`.
- Expired same request reacquire получает strictly greater fencing token.
- Stale fencing token не может commit после reacquire.
- `commitTurn` проверяет revision, active owner, current token, unexpired lease, candidate state, turn record и public response до публикации.
- Success публикует state + turn + response + operation completion и освобождает active owner как один semantic commit.
- Failed commit не оставляет partial state/turn/response.
- `finishWithoutTurn` сохраняет replayable response без game revision change.
- `npm run test:storage` стал реальной командой и входит в `verify`.
- Boundary gate теперь отдельно запрещает Core импортировать Runtime.

## Проверено

Первый code gate PR #12: CI `34036049442` — success.

После semantic audit исправлена canonical hash comparison. Final functional gate: CI `34036284044` — success:

- contract 35/35;
- Core 55/55;
- storage 7/7;
- boundaries passed;
- docs check passed.

Именованные storage tests:

1. T10 Memory — duplicate commits once, persisted response replays, different hash conflicts; SHA casing canonicalized.
2. T11 Memory — две разные команды не владеют одной session/revision одновременно.
3. T12 foundation — expired lease reacquire получает больший fencing token, stale worker commit отклонён.
4. failed commit → no partial state/turn/response.
5. service lease clock независим от game clock.
6. `finishWithoutTurn` replay без revision change.
7. `renewLease` сохраняет fencing token и использует service time.

ADR: `docs/decisions/0011-operation-idempotency-fencing-memory-reference.md`.  
Worklog: `docs/worklog/2026-09-06-b04-01.md`.

## Что B04-01 не доказывает

- durability/restart;
- настоящий SQLite transaction;
- crash-before/after-commit recovery через новый process/adapter instance;
- `SQLITE_BUSY` policy;
- Fastify/HTTP;
- guest session ownership/auth;
- PlayerView/public projection/T15.

Поэтому **общий B04 остаётся open**, а T12 закрыт только foundation-уровнем.

## Следующее действие после merge/push-CI B04-01

Создать ветку от проверенного `main` и выполнить только [B04-02 — SQLite transaction, restart и fault recovery](tasks/B04-02-sqlite-restart-fault-recovery.md).

B04-02 должен:

- реализовать один `SQLiteRuntimeStorage` с тем же domain outcomes;
- запускать общий semantic suite и для Memory, и для SQLite;
- доказать lost-response replay после закрытия/повторного открытия DB;
- использовать две независимые adapter instance для concurrent T11;
- доказать crash-before-commit, expired lease/reacquire после restart и stale old token rejection;
- обеспечить atomic state+turn+response+operation completion transaction;
- иметь bounded `SQLITE_BUSY` handling без повторного Core execution.

Не добавлять HTTP/auth/PlayerView до B04-03 и не менять B03 scheduler semantics.

## Решения

- ADR 0010 — закрытый B03 scheduler/replay contract.
- ADR 0011 — B04 operation idempotency/lease/fencing + Memory reference semantics.

## Dependency observation

`npm ci` по-прежнему сообщает 2 vulnerabilities (1 moderate, 1 high). Force-upgrade не смешивать с storage semantics без отдельного change set.
