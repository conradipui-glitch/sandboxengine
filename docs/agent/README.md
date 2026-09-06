# Контекст для агента

Это короткая человеческая точка входа. Сначала прочитай [README](../../README.md), [STATUS](../STATUS.md), [HANDOFF](../HANDOFF.md) и карточку текущей задачи. Полное ТЗ — [docs/SPECIFICATION.md](../SPECIFICATION.md). Машинно собранный текущий контракт находится в [SKILL.md](SKILL.md).

## Принятая лестница причинности

Не смешивай разные обязанности:

1. `ResolvedIntent` — что понял ввод; без duration/effects/state mutation.
2. `Condition` — чистая проверка предпосылки по authoritative `WorldState`.
3. Action/social resolver — что реально возможно и какой смысл имеет explicit действие.
4. `CalculatedAction` — строгий рассчитанный outcome.
5. `tryApplyEffectBatch` — all-or-nothing typed world mutation на trial state.
6. `planTimeAdvance` — static integer interval и deterministic event order.
7. `processTimeAdvancePlan` — deterministic processing initial + generated events на trial state с bounded budget.
8. `projectTaskEvents` / `projectDeadlineEvent` — authored task/deadline → strict scheduler events.
9. Terminal semantics — previous effects учитываются, terminal останавливает interval в своём timestamp, later due events остаются unprocessed.
10. Functional `lcg32-v1` RNG + `buildSchedulerReplayFingerprint` — explicit provenance и deterministic replay/hash.
11. **Runtime/Storage B04** — сохраняет один уже рассчитанный candidate transition либо ничего; не создаёт новую игровую причинность.

## B03 принят и опубликован

Main merge: `acb61b75b7b1fbcf782d6451a52230402e1d158d`.  
Main push-CI: `34035223262` — success.

Принятые gameplay effects: `entity.move`, `item.transfer`, `resource.change`.

Принятые scheduler priorities первого выпуска:

- world event `10`;
- task/step completion `20`;
- deadline `100`;
- synthetic task-start internal order `19`.

B03 acceptance доказана T05/T06/T08 + replay hash. Не менять эти semantics в B04.

## Текущая задача — B04-01

Карточка: [B04-01 — operation/storage contract и Memory reference semantics](../tasks/B04-01-operation-storage-contracts.md).

Цель первого B04 slice — доказать семантику operation ownership до SQLite/HTTP:

- `RuntimeStorage` как единый semantic contract;
- `claimOperation(sessionId, idempotencyKey, requestHash, expectedRevision, lease)`;
- same key + same hash → existing processing/completed operation, без второго execution;
- same key + different hash → explicit reuse conflict;
- одна active operation на session;
- monotonic fencing token;
- injected service clock для lease, который не связан с `WorldState.clock`;
- commit проверяет revision + active owner + current unexpired token;
- state + turn record + public response + operation completion атомарны;
- Memory adapter служит reference semantics для будущего SQLite;
- реальные storage regressions: T10 Memory, T11 Memory, stale-worker fencing foundation T12.

## Что не входит в B04-01

Не добавляй:

- SQLite/restart durability;
- Fastify/HTTP endpoints;
- guest auth;
- PlayerView projection;
- LLM;
- Studio/Control API;
- queues/background workers;
- Redis/WebSocket;
- изменения Core scheduler/effect/terminal semantics.

B04-01 не принимает общий B04. После него ожидаются B04-02 SQLite/restart/fault injection и B04-03 Runtime API/T15.

## Следующий точный шаг

Открой фактический `packages/runtime`, затем сначала зафиксируй минимальные storage domain result unions и interface. Сразу рядом напиши Memory/fake-clock regressions, чтобы API контракта формировался из T10/T11/fencing риска, а не из удобства будущего SQLite или HTTP.

Если `npm run test:storage` отсутствует/заглушка, преврати его в реальную проверку только вместе с первыми настоящими storage tests. Planned HTTP registry entries пока не рекламировать как available.
