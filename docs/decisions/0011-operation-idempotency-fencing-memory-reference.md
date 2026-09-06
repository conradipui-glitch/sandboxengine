# ADR 0011 — operation idempotency, lease/fencing и Memory reference semantics

Статус: accepted для B04-01  
Дата: 2026-09-06

## Контекст

После принятого B03 Core умеет детерминированно вычислить один candidate transition, но ещё не было слоя, который гарантирует единственную публикацию результата при повторной отправке, конкуренции обработчиков и ожившем старом worker.

B04 должен добавить persistence/runtime, не меняя причинность B03. До SQLite и HTTP нужна одна точная семантика operation lifecycle, которую последующие adapters обязаны воспроизвести.

## Решение

1. Runtime хранит `SessionRecord`, `OperationRecord`, минимальный `TurnRecordBoundary` и persisted public response через единый `RuntimeStorage` contract.
2. Идентичность повторного запроса задаётся `(sessionId, idempotencyKey)` и привязана к canonical lowercase SHA-256 `requestHash` + исходной `expectedRevision`.
3. Same key + same canonical hash + completed/finished operation возвращает сохранённый response **до** проверки текущей revision. Повтор не запускает второй commit.
4. Same key с другим hash или другой исходной revision — `idempotency_key_reused`.
5. У session одновременно только одна active operation. Другая команда получает `action_in_progress`, а не скрытую очередь.
6. Lease использует injected `ServiceClock`; это служебное время и оно не связано с `WorldState.clock`.
7. Каждый claim/reacquire получает монотонный fencing token. Истёкший тот же запрос может reacquire ту же operation с большим token. Старый token больше не может renew/commit.
8. `commitTurn` проверяет вместе: expected revision, active operation ownership, current fencing token, unexpired lease, candidate state revision/invariants, turn record и public response.
9. При успехе candidate state, turn record, persisted response, operation completion и освобождение active operation образуют один semantic commit. При любой ошибке наружу не публикуется partial state/turn/response.
10. `finishWithoutTurn` завершает operation и сохраняет replayable response без изменения игрового state/revision.
11. `MemoryRuntimeStorage` является reference semantics внутри процесса. Он **не** даёт durability/restart guarantee; SQLite в B04-02 обязан пройти тот же semantic suite плюс fault/restart tests.
12. HTTP status codes не входят в storage domain outcomes. Transport mapping появится только в B04-03.

## Следствия

- Runtime/Storage не вызывает и не переопределяет B03 scheduler semantics.
- Скачок игрового времени не продлевает и не истекает service lease.
- Потерянный HTTP-ответ после будущего durable commit сможет восстанавливаться через persisted operation response.
- «Exactly once» здесь означает один зафиксированный игровой эффект на idempotency key; до durable B04-02 это ещё не обещание пережить process restart.

## Доказательства B04-01

PR #12 functional gate после canonical request-hash fix: CI `34036284044` — success.

- contract tests 35/35;
- Core tests 55/55;
- storage tests 7/7;
- boundary check passed;
- docs check passed.

Именованные regressions: T10 Memory, T11 Memory, T12 fencing foundation, failed-commit atomicity, service/game clock isolation, `finishWithoutTurn` replay и lease renewal. T10 дополнительно проверяет одинаковый SHA-256 при разном hex casing.

## Не решено этим ADR

SQLite transactions/restart, crash recovery, `SQLITE_BUSY`, Runtime HTTP, guest auth и PlayerView/T15 относятся к следующим bounded slices B04.
