# Статус движка

Последнее обновление: 2026-09-06. Источник краткого статуса — этот файл; подробности и решения находятся по ссылкам.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий и навигация | B01/B02/B03 приняты; B04-01/B04-02 опубликованы; B04-03 accepted на branch | B03 merge `acb61b75b7b1fbcf782d6451a52230402e1d158d`; B04-01 merge `c6e63be1bf9ac1998270220c6f8820a006b5c3ac`; B04-02 merge `a1ed4312406d4296f6e8742abcda7417437b1df7`; B04-03 PR #14 |
| Контракты/Core | B01–B03 приняты | typed actions/effects/conditions/social semantics, deterministic scheduler/tasks/terminal/RNG/replay |
| Runtime storage contract | **B04-01 published** | `RuntimeStorage`, Memory reference semantics, service clock, idempotency + fencing; ADR 0011 |
| Storage durability | **B04-02 published** | `SQLiteRuntimeStorage`, restart/fault/busy tests, durable T10–12; ADR 0012; push-CI `34037394667` |
| Runtime HTTP / public projection | **B04-03 accepted на PR #14** | guest ownership, deny-by-default PlayerView, explicit action API, operation recovery, T15; ADR 0013 |
| Общий B04 | **accepted на branch; publication pending final PR/main gate** | T10–12 + T15 green; registry/generated docs publish 5 implemented Runtime operations only |
| Studio/Player | не начато | следующий canonical блок определяется отдельной task-card после публикации B04 |
| AI-провайдеры/свободный ввод | не начато | B06 |
| Плагины/Builder | не начато | будущие блоки |
| Миграция Florence | не начато | B11 |

## Принятая база B03

Core остаётся чистым от storage/runtime и определяет игровую причинность. Runtime не меняет scheduler/action/effect semantics.

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

## B04-01 — semantic storage foundation

Main merge: `c6e63be1bf9ac1998270220c6f8820a006b5c3ac`.  
Push-to-main CI: `34036478296` — success.

Принято:

- transport-agnostic `RuntimeStorage`;
- canonical idempotency identity `(session, key, requestHash, expectedRevision)`;
- one active operation per session;
- injected `ServiceClock`, отдельно от `WorldState.clock`;
- expired same request reacquire → greater fencing token;
- stale fencing token не может commit;
- state + turn + public response + operation completion публикуются atomically;
- completed duplicate возвращает persisted response без второго commit;
- Core boundary запрещает импорт Runtime.

Решение — ADR 0011.

## B04-02 — durable SQLite

Main merge: `a1ed4312406d4296f6e8742abcda7417437b1df7`.  
Push-to-main CI: `34037394667` — success.

Принято:

- built-in Node 24.19 `node:sqlite`, без нового native driver;
- versioned sessions/operations/turns/runtime metadata schema;
- short `BEGIN IMMEDIATE` transactions;
- persistent fencing + operation counters;
- lost-response recovery после reopen;
- two-instance ownership test;
- fault-before-COMMIT rollback;
- restart/reacquire + stale fencing rejection;
- bounded real SQLite busy policy;
- shared Memory/SQLite semantic suite.

Решение — ADR 0012.

## B04-03 — Runtime HTTP / guest / PlayerView

Карточка: [B04-03 — Runtime HTTP, guest ownership и player-safe projection](tasks/B04-03-runtime-http-guest-player-projection.md).

Реализовано:

- отдельный Node server project в `apps/server`;
- guest credential выдаётся opaque, SHA-256 verifier хранится отдельно от игрового state;
- ownership проверяется server-side до read/mutation;
- deny-by-default `PlayerView`, не raw `WorldState`;
- `GET /healthz`;
- `POST /v1/sessions`;
- owner-only `GET /v1/sessions/{sessionId}`;
- explicit `POST /v1/sessions/{sessionId}/actions` с `Idempotency-Key` + expected revision;
- public `GET /v1/sessions/{sessionId}/operations/{operationId}` без lease/fencing/hash internals;
- server-side canonical SHA-256 request identity;
- completed HTTP retry возвращает persisted response до второго Core execution;
- real SQLite busy → `503 STORAGE_BUSY` без partial operation/Core execution;
- malformed/oversize/unsupported input и cross-owner mutation не достигают Core;
- guest ownership и completed replay переживают restart.

Functional/hardening gate `34038239722` — success.  
Registry/generated-doc publication gate `34039363270` — success.

Generated contract теперь рекламирует ровно 5 available Runtime operations; `/v1/quests` и Control API остаются `planned`. `POST /v1/sessions` публикуется с success `201`.

Решение — ADR 0013.

## Canonical B04 audit

На одном B04-03 branch-state зелёные:

- T10 durable idempotent replay;
- T11 single owner / no lost update;
- T12 crash/restart/fencing;
- T15 guest ownership / player-safe projection / retry;
- contracts 35/35;
- Core 55/55;
- storage 20/20;
- server regressions;
- `check:boundaries`;
- `docs:check`.

Поэтому общий B04 **accepted по code/semantic/docs audit**. Публикацией считать только после финального current-head PR #14 gate, merge и зелёного push-to-main CI.

## Scope boundary

В B04 не добавлены:

- free-text intent/narrator/provider API;
- Studio/Control editing API;
- Florence-specific logic;
- WebSocket/Redis/background realtime;
- debug raw-state mutation API.

Известное наблюдение CI: `npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high); force-upgrade без отдельного аудита не выполнялся.
