# Передача работы

Обновлено: 2026-09-06

Текущий блок: **B04-01 — operation/storage contract и Memory reference semantics**  
База ветки: опубликованный B03 merge `acb61b75b7b1fbcf782d6451a52230402e1d158d`  
Текущая ветка: `b04-01-operation-storage-contracts`  
Task-card commit: `30b8790894b27abe2ebe075f57d01d93b02d192b`  
Статус: `in_progress`; код B04-01 ещё не реализован

## Принятая база

Общий B03 полностью принят и опубликован. Main push-CI `34035223262` — success. Принятые Core semantics, включая scheduler priority/terminal/RNG/replay, в B04 не переписываются.

B04 хранит и атомарно публикует уже рассчитанный Core candidate transition либо не сохраняет ничего.

## Текущий bounded scope

Карточка: [B04-01 — operation/storage contract и Memory reference semantics](tasks/B04-01-operation-storage-contracts.md).

Этот срез закрывает только foundation вокруг operation ownership:

- строгие runtime/storage domain types;
- единый semantic `RuntimeStorage` contract;
- `claimOperation(sessionId, idempotencyKey, requestHash, expectedRevision, lease)`;
- explicit outcomes для duplicate/reuse/action-in-progress/revision-conflict;
- Memory reference adapter;
- одна active operation на session;
- unique `(sessionId, idempotencyKey)`;
- monotonic fencing token;
- injected service clock для lease, отдельно от game clock;
- commit проверяет expected revision + active owner + current unexpired token;
- atomic state + turn record + public response + operation completion;
- `finishWithoutTurn` / `getOperation` foundation;
- реальные storage tests для T10 Memory, T11 Memory и stale-worker fencing foundation T12.

## Что B04-01 не делает

- SQLite;
- restart/crash durability claim;
- Fastify/HTTP;
- guest auth/session tokens;
- PlayerView/public projection;
- bundled release server startup;
- JS client;
- LLM/provider logic;
- Studio/Control API;
- background workers/queues;
- изменение B03 Core semantics.

Поэтому B04-01 **не принимает общий B04** и не закрывает T12 целиком.

## Следующее точное действие

1. Прочитать `docs/tasks/B04-01-operation-storage-contracts.md` и фактический каркас `packages/runtime`.
2. Спроектировать минимальные domain result unions и `RuntimeStorage` interface без HTTP status codes.
3. Сразу написать Memory adapter + fake service clock tests для T10/T11/stale fencing; не начинать SQLite до зелёной Memory semantics.
4. Если `npm run test:storage` отсутствует или является заглушкой — сделать его реальной командой и включить в обязательный verify только после появления настоящих storage tests.
5. После functional gate обновить STATUS/HANDOFF/worklog и только затем решить B04-01 acceptance.

## Следующие bounded slices после B04-01

- **B04-02:** SQLite atomicity + restart/fault injection, durable T10–12.
- **B04-03:** Runtime API + guest access + player-safe projection, T15 и общая B04 canonical acceptance.

Не объявлять общий B04 принятым до повторной сверки T10–12/T15.

## Архитектурные решения, которые нельзя размыть

- Core не импортирует Runtime/Storage.
- Service lease time ≠ `WorldState.clock`.
- Storage не пересчитывает candidate transition.
- Duplicate completed request возвращает сохранённый response без второго Core/commit.
- Reused idempotency key с другим request hash никогда не становится новым действием.
- Старый fencing token не может commit после reacquire.
- HTTP-коды появляются только в transport layer будущего B04-03.

## Известное наблюдение dependency layer

`npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high). Force-upgrade не смешивать с B04-01 semantics без отдельного change set.
