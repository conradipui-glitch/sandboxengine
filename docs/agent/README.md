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
9. Durable adapter B04-02 обязан воспроизвести B04-01 semantics транзакционно.
10. HTTP B04-03 только отображает domain outcomes и безопасную player projection; transport не меняет storage/Core semantics.

## Принято до текущей точки

B03 опубликован в `main`: merge `acb61b75b7b1fbcf782d6451a52230402e1d158d`, push-CI `34035223262` success.

B04-01 accepted bounded после functional CI `34036284044`:

- package `@living-history/runtime` существует;
- `RuntimeStorage` domain contract существует;
- `MemoryRuntimeStorage` является reference semantics;
- same completed idempotency key/hash → persisted replay;
- canonical request SHA-256 сравнивается независимо от hex casing;
- same key/different hash or base revision → reuse conflict;
- одна active operation на session;
- lease использует injected `ServiceClock`, отдельно от game clock;
- reacquire expired same request → greater fencing token;
- stale token не может commit;
- commit атомарно публикует state + turn + response + operation completion;
- failed commit не оставляет partial публикацию;
- `finishWithoutTurn` replayable без изменения game revision;
- `test:storage` — реальный обязательный gate;
- Core не импортирует Runtime.

Решение: ADR 0011.

## Текущая следующая задача — B04-02

Карточка: [B04-02 — SQLite transaction, restart и fault recovery](../tasks/B04-02-sqlite-restart-fault-recovery.md).

Цель: доказать те же outcomes не в памяти процесса, а через один durable SQLite adapter.

Обязательные риски:

- same key/hash после commit + restart возвращает сохранённый response и не удваивает revision/turn;
- две независимые SQLite adapter instance не получают ownership одновременно;
- crash after claim but before commit не меняет WorldState;
- после lease expiry/restart reacquire получает больший fencing token;
- старый token после reacquire не может commit;
- state + turn + response + operation completion сохраняются одной transaction;
- transaction/fault failure не оставляет partial rows/state;
- `SQLITE_BUSY` имеет bounded storage retry и не запускает Core повторно.

Shared semantic tests должны гоняться на Memory и SQLite, чтобы adapter не создавал вторую семантику.

## Что не делать сейчас

Не добавляй:

- Fastify/HTTP endpoints;
- guest token/cookie/auth;
- PlayerView/T15;
- Studio/Control API;
- LLM;
- Redis/queues/websocket;
- несколько storage adapters «на будущее»;
- изменения Core scheduler/action/effect semantics;
- полный project/draft/publication database раньше соответствующих блоков.

Общий B04 остаётся open до B04-03 и canonical T10–12/T15 audit.

## Минимальный цикл

Один bounded slice → реальные fault/restart regressions → `npm run verify` → ADR/STATUS/HANDOFF/worklog → PR gate → merge → push-CI. Не переходить к HTTP до принятого B04-02.
