# B04-01 — operation/storage contract и Memory reference semantics

## Цель

Начать B04 с самого рискованного инварианта persistent runtime: **один зафиксированный переход мира на один idempotency key, один активный владелец операции сессии и fencing против ожившего старого worker**.

Этот срез формализует storage/runtime semantics и реализует Memory reference adapter для конкурентных проверок внутри процесса. SQLite, restart persistence и HTTP в B04-01 **не входят**.

## Вход

- B03 полностью принят и опубликован в `main` merge `acb61b75b7b1fbcf782d6451a52230402e1d158d`;
- B03 Core возвращает уже рассчитанный immutable candidate transition; Runtime/Storage не переписывает scheduler/effect/terminal semantics;
- `docs/SPECIFICATION.md` §8.1–8.4, §15–16;
- canonical B04 acceptance T10–12/T15.

## Главный invariant

Storage не «сохраняет состояние когда получится». Он атомарно владеет жизненным циклом одной операции:

```text
claim operation
  ↓
exclusive owner + fencing token + lease
  ↓
Core/runtime computes outside storage transaction
  ↓
commit checks revision + active owner + current unexpired fencing token
  ↓
state + turn record + public response + operation completion committed together
```

Если какая-либо проверка commit не проходит, наружу не выходит частично записанный state/result.

## Сделать

### 1. Runtime storage domain types

В `packages/runtime` добавить минимальные строгие типы для storage orchestration без HTTP-кодов:

- `SessionRecord` / session snapshot с `sessionId`, pinned release identity, authoritative `WorldState`, revision и active operation;
- `OperationRecord` с:
  - `operationId`;
  - `sessionId`;
  - `idempotencyKey`;
  - `requestHash`;
  - `expectedRevision`;
  - status;
  - lease expiry service-time;
  - fencing token;
  - persisted public response/result при completion;
- immutable turn record boundary в минимальном объёме, достаточном для atomic commit/recovery; не создавать полный future trace/AI DTO раньше B06.

IDs/keys/hash/status должны иметь bounded validation policy. Не хранить секреты или полный внутренний prompt.

### 2. Единый semantic `RuntimeStorage` contract

Определить интерфейс как одну связанную семантику, а не независимый CRUD:

- `loadSession`;
- `claimOperation(sessionId, idempotencyKey, requestHash, expectedRevision, lease)`;
- `renewLease` или эквивалентную условную операцию с тем же fencing token;
- `commitTurn(expectedRevision, fencingToken, candidateState, turnRecord, publicResponse)`;
- `finishWithoutTurn`;
- `getOperation`.

Storage layer не возвращает HTTP 200/409/202. Он возвращает explicit domain outcomes, которые B04 HTTP layer позже преобразует в transport status.

### 3. `claimOperation` outcomes

Минимально различить:

- новая операция успешно захвачена;
- тот же key + тот же request hash уже completed → вернуть сохранённый result/response без нового Core execution;
- тот же key + тот же request hash ещё processing → вернуть существующую operation identity/status;
- тот же key + другой request hash → `idempotency_key_reused`;
- другая команда при активной operation сессии → `action_in_progress`;
- `expectedRevision` не совпадает → `revision_conflict`.

Порядок проверок должен быть deterministic и протестирован: повтор уже существующего key разрешается восстановить **до** создания новой конкурирующей операции, но reused key с другим request hash никогда не становится новым действием.

### 4. Memory reference adapter

Реализовать in-process Memory adapter, который проходит те же semantic tests, что позже SQLite:

- unique `(sessionId, idempotencyKey)`;
- одна `activeOperationId` на session;
- monotonic fencing counter на session;
- новая/reacquired lease получает fencing token строго больше предыдущего;
- authoritative state не мутируется до успешного commit;
- operation result/public response сохраняются и возвращаются повторно;
- completion освобождает active operation атомарно вместе с сохранением нового состояния/result.

Memory adapter — reference semantics для тестов, а не утверждение о crash persistence.

### 5. Service clock отдельно от game clock

Lease использует **server/service time**, а не `WorldState.clock.elapsedSeconds`.

Добавить injected `ServiceClock` (или эквивалентный минимальный interface):

- production implementation пока не требуется;
- deterministic fake/manual clock для тестов обязателен;
- никакой lease logic внутри `packages/core`;
- advancement game clock не должен продлевать/истекать operation lease.

Wall-clock допустим в будущей Runtime implementation, но не смешивается с B03 game clock.

### 6. Commit fencing semantics

`commitTurn` обязан атомарно проверить минимум три условия из канонического §8.1:

1. session revision всё ещё равна `expectedRevision`;
2. `activeOperationId` соответствует committing operation;
3. fencing token является текущим и lease не истёк.

Дополнительно candidate state должен соответствовать ожидаемому следующему revision policy; storage не пересчитывает Core transition и не исправляет candidate state молча.

При failure:

- authoritative session state не меняется;
- turn record не появляется;
- public response не сохраняется как success;
- active/current ownership меняется только по явно определённой recovery policy, не как побочный эффект failed commit.

### 7. Lease expiry/reacquire foundation для T12

Memory tests должны доказать:

- worker A получает token N;
- lease A истекает по fake service clock;
- тот же исходный request может быть reacquired согласно policy и получает token N+1;
- оживший worker A с token N не может commit;
- worker B с current token N+1 может commit при неизменившейся revision;
- если revision уже изменилась другой committed command, старый request не исполняется на новом мире.

Это только fencing/recovery foundation. Полный restart/crash durability T12 относится к SQLite-срезу.

### 8. Реальные storage tests и npm script

Если `npm run test:storage` пока отсутствует/заглушка — добавить реальную команду, которая исполняет storage tests.

Минимальные именованные regressions:

#### T10 Memory — duplicate/idempotency

- first claim → acquired;
- commit ровно один раз;
- same key + same hash → persisted completed response;
- session revision/state второй раз не меняются;
- same key + different hash → explicit reuse conflict.

#### T11 Memory — single operation owner

- две разные команды с одной исходной revision пытаются claim одной session;
- только одна получает ownership;
- вторая получает `action_in_progress` либо после первого commit — `revision_conflict` согласно моменту проверки;
- невозможно получить два одновременно валидных fencing tokens для одной активной revision.

#### T12 foundation — stale worker fencing

- expired lease → reacquire с большим token;
- stale worker commit rejected;
- current worker commit succeeds;
- no partial state/result from rejected commit.

### 9. Boundary tests

- `packages/core` не импортирует runtime/storage;
- storage adapter не вызывает/копирует scheduler logic;
- no HTTP/Fastify in this slice;
- generated HTTP registry остаётся planned и не рекламирует endpoints как available.

## Приёмка B04-01

- clean `npm ci`;
- `npm run typecheck`;
- real `npm run test:storage`;
- `npm run test:core` остаётся зелёным;
- `npm run check:boundaries`;
- `npm run docs:check`;
- T10 Memory idempotency regression passed;
- T11 single-owner regression passed;
- stale fencing token regression passed;
- same key/same hash возвращает сохранённый response без второго commit;
- same key/different hash conflict explicit;
- service lease clock доказуемо независим от B03 game clock;
- failed commit не публикует partial state/turn/public response.

B04-01 **не принимает общий B04** и не считается полным T12, потому что restart/SQLite durability и HTTP/T15 ещё отсутствуют.

## Не делать

- SQLite и миграции БД;
- restart/fault durability claim;
- Fastify/HTTP endpoints;
- guest auth/session tokens;
- PlayerView/public projection;
- bundled release loading/server startup;
- JS client;
- LLM/provider calls;
- Studio/Control API;
- background queue/worker loop;
- Redis/WebSocket;
- изменение B03 scheduler/effect/terminal semantics.

## После приёмки

Если Memory semantics зелёные, следующий bounded slice — **B04-02 SQLite atomicity/restart/fault injection** для durable T10–12. После него отдельный **B04-03 Runtime API + guest access + player-safe projection** закрывает HTTP/T15 и общий B04.

Не объявлять общий B04 принятым до повторной canonical сверки T10–12/T15.
