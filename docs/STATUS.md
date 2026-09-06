# Статус движка

Последнее обновление: 2026-09-06. Источник краткого статуса — этот файл; подробности и решения находятся по ссылкам.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий и навигация | B01/B02/B03 приняты; B04-01 accepted bounded | B03 merge `acb61b75b7b1fbcf782d6451a52230402e1d158d`, main CI `34035223262`; B04-01 PR #12 |
| Контракты/Core | B01–B03 приняты | typed action/effects/conditions/social semantics, scheduler/tasks/terminal/RNG/replay |
| Scheduler | B03 принят | T05/T06/T08; fixed priority world 10 / completion 20 / deadline 100; deterministic replay hash |
| Runtime storage contract | **B04-01 accepted bounded** | `RuntimeStorage`, Memory reference adapter, service lease clock, idempotency + fencing; ADR 0011 |
| Storage durability | следующий B04-02 | SQLite transaction/restart/fault recovery; durable T10–12 |
| Runtime HTTP / public projection | не начато | B04-03: Runtime API, guest ownership, PlayerView/T15 |
| Общий B04 | **ещё не принят** | требует B04-02 + B04-03 и canonical T10–12/T15 audit |
| Studio/Player | не начато | B05/B07 |
| AI-провайдеры/свободный ввод | не начато | B06 |
| Плагины/Builder | не начато | B08/B13 |
| Миграция Florence | не начато | B11 |

## Принятая база B03

Core остаётся чистым от storage/runtime и определяет игровую причинность. Приняты:

- integer game clock без `Date`/wall-clock;
- typed atomic effects и `entity.move`;
- static + dynamic deterministic scheduler;
- global event/step budget;
- terminal interruption;
- task/deadline projection;
- explicit deterministic RNG provenance;
- canonical replay SHA-256 fingerprint;
- T05/T06/T08.

B04 не имеет права менять эти semantics.

## Что доказано в B04-01

Создан реальный `@living-history/runtime` package и semantic `RuntimeStorage` contract.

Memory reference semantics:

- unique `(sessionId, idempotencyKey)`;
- request identity связана с canonical lowercase SHA-256 + исходной `expectedRevision`;
- completed same key/hash возвращает persisted response без второго commit;
- same key с другим hash/revision → explicit reuse conflict;
- одна active operation на session;
- lease работает через injected `ServiceClock`, отдельно от `WorldState.clock`;
- expired same request reacquire получает больший fencing token;
- stale worker/token не может commit;
- `commitTurn` проверяет revision + active owner + current unexpired token + candidate/turn/response;
- state + turn record + public response + operation completion публикуются как один semantic commit;
- failed commit не оставляет partial state/turn/response;
- `finishWithoutTurn` сохраняет replayable response без изменения game revision;
- Core boundary дополнительно запрещает импорт Runtime.

Final functional PR #12 gate после canonical hash fix: CI `34036284044` — success:

- contract tests 35/35;
- Core tests 55/55;
- storage tests 7/7;
- `check:boundaries` passed;
- `docs:check` passed.

Именованные storage regressions: T10 Memory, T11 Memory, T12 fencing foundation, failed-commit atomicity, service/game-clock isolation, `finishWithoutTurn` replay, lease renewal. T10 включает retry с тем же SHA-256 в другом hex casing.

Решение — ADR 0011. B04-01 не даёт durability/restart guarantee и не принимает общий B04.

## Следующая точка — B04-02

Карточка: [B04-02 — SQLite transaction, restart и fault recovery](tasks/B04-02-sqlite-restart-fault-recovery.md).

Нужно реализовать один SQLite adapter с тем же `RuntimeStorage` contract и доказать:

- durable duplicate replay после restart/lost response;
- две независимые adapter instance не получают ownership одновременно;
- crash before commit не меняет мир;
- expired lease после restart reacquire получает больший fencing token;
- stale old worker/token не может commit;
- current worker commit сохраняется один раз;
- transaction failure не оставляет partial state/turn/response;
- bounded `SQLITE_BUSY` handling без повторного Core execution.

HTTP/Fastify/auth/PlayerView в B04-02 не добавлять. Они относятся к B04-03.

Известное наблюдение CI: `npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high); force-upgrade без отдельной проверки не выполнялся.
