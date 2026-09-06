# Статус движка

Последнее обновление: 2026-09-06. Источник краткого статуса — этот файл; подробности и решения находятся по ссылкам.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий и навигация | B01/B02/B03 приняты; B04-01/B04-02 accepted bounded | B03 merge `acb61b75b7b1fbcf782d6451a52230402e1d158d`; B04-01 merge `c6e63be1bf9ac1998270220c6f8820a006b5c3ac`; B04-02 PR #13 |
| Контракты/Core | B01–B03 приняты | typed action/effects/conditions/social semantics, scheduler/tasks/terminal/RNG/replay |
| Runtime storage contract | **B04-01 accepted/published** | `RuntimeStorage`, Memory reference semantics, service clock, idempotency + fencing; ADR 0011 |
| Storage durability | **B04-02 accepted bounded** | `SQLiteRuntimeStorage`, restart/fault/busy tests, durable T10–12; ADR 0012; merge/push gate PR #13 остаётся |
| Runtime HTTP / public projection | следующий B04-03 | guest ownership, explicit-action Runtime API, deny-by-default PlayerView, T15 |
| Общий B04 | **ещё не принят** | требует опубликованного B04-02 + B04-03 и canonical T10–12/T15 audit |
| Studio/Player | не начато | B05/B07 |
| AI-провайдеры/свободный ввод | не начато | B06 |
| Плагины/Builder | не начато | B08/B13 |
| Миграция Florence | не начато | B11 |

## Принятая база B03

Core остаётся чистым от storage/runtime и определяет игровую причинность. B04 не меняет scheduler/action/effect semantics.

Приняты:

- integer game clock без `Date`/wall-clock;
- typed atomic effects и `entity.move`;
- deterministic static + dynamic scheduler;
- global event/step budget;
- terminal interruption;
- task/deadline projection;
- explicit deterministic RNG provenance;
- canonical replay SHA-256 fingerprint;
- T05/T06/T08.

## B04-01 — опубликованная semantic foundation

Main merge: `c6e63be1bf9ac1998270220c6f8820a006b5c3ac`.  
Push-to-main CI: `34036478296` — success.

Принято:

- transport-agnostic `RuntimeStorage`;
- `MemoryRuntimeStorage` как reference semantics;
- unique `(sessionId, idempotencyKey)`;
- canonical request SHA-256 + исходная `expectedRevision`;
- persisted replay same key/hash без второго commit;
- one active operation per session;
- injected `ServiceClock`, отдельно от `WorldState.clock`;
- expired same request reacquire → greater fencing token;
- stale fencing token не может commit;
- state + turn + public response + operation completion публикуются atomically;
- failed commit не публикует partial state/turn/response;
- `finishWithoutTurn` replayable без game revision change;
- `npm run test:storage` входит в обязательный verify;
- Core boundary запрещает импорт Runtime.

Решение — ADR 0011.

## B04-02 — functional acceptance на PR #13

Карточка: [B04-02 — SQLite transaction, restart и fault recovery](tasks/B04-02-sqlite-restart-fault-recovery.md).

Реализован один durable `SQLiteRuntimeStorage` на built-in Node 24.19 `node:sqlite` с тем же `RuntimeStorage` contract.

Принятые semantics B04-01 воспроизведены через SQLite:

- versioned minimal schema: runtime metadata, sessions, operations, turns;
- unique `(session_id, idempotency_key)` и persistent fencing counter;
- short `BEGIN IMMEDIATE` transactions для claim/renew/commit/finish;
- state + revision + turn + public response + operation completion + clear active owner — один SQLite COMMIT;
- никаких Core/LLM вызовов внутри write transaction;
- lost-response recovery после close/reopen DB;
- две независимые adapter instance не получают ownership одновременно;
- fault injection before COMMIT вызывает rollback без partial публикации;
- lease expiry + restart/reacquire сохраняет monotonic fencing;
- stale old token после reacquire не commit;
- `finishWithoutTurn` fault также rollback;
- реальный SQLite write lock проверяет bounded busy failure;
- bounded busy policy использует adapter `DatabaseSync.timeout`; storage busy не запускает Core повторно.

Functional PR #13 CI `34036777799` — success:

- contract tests: 35/35;
- Core tests: 55/55;
- storage tests: 20/20;
- `check:boundaries`: passed;
- `docs:check`: passed.

Storage log включает literal durable T10, T11, T12, shared Memory/SQLite contract suite, fault rollback и real busy-lock case.

Решение — ADR 0012 `sqlite-durable-runtime-storage`.

B04-02 **accepted bounded по code/semantic gate**, но считается опубликованным только после финального docs PR gate, merge #13 и push-to-main CI.

## Следующая точка — B04-03

Карточка: [B04-03 — Runtime HTTP, guest ownership и player-safe projection](tasks/B04-03-runtime-http-guest-player-projection.md).

После публикации B04-02 следующий bounded slice должен добавить только:

- Node Runtime server в `apps/server`;
- `GET /v1/health`;
- guest session creation/ownership;
- owner-only `GET /v1/sessions/:id`;
- explicit-action `POST /v1/sessions/:id/actions` с `Idempotency-Key` + `expectedRevision`;
- public operation recovery endpoint;
- deny-by-default `PlayerView`, никогда не raw `WorldState`;
- отдельный domain-outcome → HTTP mapping;
- T15 public projection/retry/ownership regressions;
- финальный canonical B04 audit T10–12/T15.

Свободный текст/LLM, Studio/Control API и Florence migration в B04-03 не входят.

Известное наблюдение CI: `npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high); force-upgrade без отдельной проверки не выполнялся.
