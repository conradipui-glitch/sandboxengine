# Контекст для агента

Это короткая человеческая точка входа. Сначала прочитай [README](../../README.md), [STATUS](../STATUS.md), [HANDOFF](../HANDOFF.md) и карточку текущей задачи. Полное ТЗ — [docs/SPECIFICATION.md](../SPECIFICATION.md). Машинно собранный текущий контракт находится в [SKILL.md](SKILL.md).

## Принятая лестница причинности

Не смешивай обязанности:

1. `ResolvedIntent` — что понял ввод; без duration/effects/state mutation.
2. `Condition` — чистая проверка предпосылок.
3. Action/social resolver — что реально возможно.
4. `CalculatedAction` — рассчитанный outcome.
5. `tryApplyEffectBatch` — atomic typed world mutation на trial state.
6. `planTimeAdvance` / `processTimeAdvancePlan` — детерминированное игровое время и события.
7. Task/deadline/terminal/RNG/replay — принятый B03 Core.
8. `RuntimeStorage` — публикует один уже рассчитанный candidate transition либо ничего; не создаёт новую игровую причинность.
9. `MemoryRuntimeStorage` задаёт semantic reference B04-01.
10. `SQLiteRuntimeStorage` воспроизводит те же semantics durable transaction/restart/fault cases B04-02.
11. HTTP B04-03 только аутентифицирует guest, валидирует transport input, вызывает существующий lifecycle и возвращает player-safe projection.

## Принято и опубликовано

B03: merge `acb61b75b7b1fbcf782d6451a52230402e1d158d`, push-CI `34035223262` success.

B04-01: merge `c6e63be1bf9ac1998270220c6f8820a006b5c3ac`, push-CI `34036478296` success.

B04-01 guarantees:

- transport-agnostic `RuntimeStorage`;
- canonical idempotency identity `(session, key, requestHash, expectedRevision)`;
- one active operation;
- service lease clock ≠ game clock;
- monotonic fencing;
- stale worker cannot commit after reacquire;
- state + turn + public response + operation completion atomic;
- completed duplicate returns persisted response;
- Core cannot import Runtime.

Решение: ADR 0011.

## B04-02 — accepted bounded, publishing gate

Карточка: [B04-02 — SQLite transaction, restart и fault recovery](../tasks/B04-02-sqlite-restart-fault-recovery.md).

Реализован `SQLiteRuntimeStorage` на built-in `node:sqlite` с тем же contract.

Доказано в PR #13 CI `34036777799`:

- 35/35 contracts;
- 55/55 Core;
- 20/20 storage;
- boundaries/docs passed;
- durable T10 lost-response replay after close/reopen;
- durable T11 two independent adapter instances / one owner;
- durable T12 fault before COMMIT → rollback, restart/reacquire → greater fencing token, stale token rejected;
- finishWithoutTurn rollback fault;
- real SQLite write-lock → bounded busy failure;
- shared Memory/SQLite semantic suite.

Решение: ADR 0012.

B04-02 нельзя считать опубликованным до финального docs gate, merge PR #13 и push-CI `main`.

## Следующая задача после публикации — B04-03

Карточка: [B04-03 — Runtime HTTP, guest ownership и player-safe projection](../tasks/B04-03-runtime-http-guest-player-projection.md).

Цель — завершить общий B04 transport layer без LLM:

- запустить Node server package в `apps/server`;
- public health;
- guest session creation + server-side ownership;
- owner-only session read;
- explicit action endpoint с `Idempotency-Key` и `expectedRevision`;
- operation status/recovery;
- server-side SHA-256 request identity;
- deny-by-default `PlayerView` вместо raw `WorldState`;
- отдельный domain outcome → HTTP mapping;
- T15 public projection/retry/ownership;
- final canonical B04 audit T10–12/T15.

## Критическая transport boundary

Не выдавай Player:

- raw `WorldState`;
- lease expiry/service clock;
- fencing token/counter;
- request hash;
- DB rows/schema errors/stacks;
- hidden state/future queue/private knowledge;
- provider secrets.

HTTP retry completed operation должен вернуть сохранённый public response **без второго Core execution**.

Guest B не может читать/менять session guest A. Ownership проверяется server-side, не UI.

## Что не делать в B04-03

Не добавляй:

- free-text intent/narrator/provider API — B06;
- Studio/Control API — будущие блоки;
- Florence migration — B11;
- Redis/queues/WebSocket/background realtime;
- публичную account registration/auth platform;
- generic plugin middleware;
- debug endpoint, меняющий raw state;
- изменения B03 scheduler/action/effect semantics.

Общий B04 объявляется accepted только после B04-03 и повторной сверки T10–12/T15.

## Минимальный цикл

Один bounded slice → реальные regressions → `npm run verify` → ADR/STATUS/HANDOFF/worklog → PR gate → merge → push-CI. Не переходить к AI/Studio до закрытия соответствующего блока.
