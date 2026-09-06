# B03-03 — tasks, deadlines, interruptions и deterministic RNG

## Цель

Закрыть общий B03 без HTTP/storage: добавить чистые task/deadline definitions, детерминированное преобразование их в scheduler events, terminal interruption длительного интервала и явный RNG/provenance contract. После этого T05–06/T08 должны иметь детерминированные Core-регрессии.

## Вход

- B03-01: integer inclusive `[start,end]` planning и deterministic queue order;
- B03-02: `core.marker` + отдельный `core.effects`, whole-transition atomicity, clock/revision commit;
- B02: typed `GameplayEffect` и authoritative-state invariants.

## Сделать

### 1. Task definition и projection

Добавить отдельный strict `ScheduledTask:1.0`, не прятать task state в произвольные JSON поля.

Минимальные поля:

- `taskId`, `sourceId`;
- `actorEntityId`;
- `startAtElapsedSeconds`;
- `completeAtElapsedSeconds` (`complete >= start`);
- bounded `startEffects[]` и `completionEffects[]` или явные empty policy;
- stable order/baseOrder.

Core `projectTaskEvents(state, task)`:

- проверяет actor reference и safe integers;
- выдаёт deterministic start/completion scheduler events со stable ids/provenance;
- не меняет state;
- одинаковый task даёт одинаковые events;
- broken actor/time definition → failure, не пустой event list.

### 2. Deadline / terminal event

Не расширять молча уже strict `ScheduledEvent:1.0` или `ScheduledEffectEvent:1.0`.

Добавить отдельный strict `ScheduledTerminalEvent:1.0`:

- kind `core.terminal`;
- `eventId`, absolute time, order, sourceId;
- bounded `reason`, `outcome`;
- никакого arbitrary code/statePatch.

Core scheduler union включает marker/effects/terminal.

### 3. Interruption semantics

Расширить apply-layer:

- terminal event в due queue применяет `WorldState.terminal` и **завершает интервал в момент этого event**;
- события после terminal event не выполняются;
- resulting clock = terminal event time, не первоначальный plan.end;
- revision увеличивается один раз;
- result явно сообщает `interrupted: true`, `interruptionEventId`, `unprocessedEvents`;
- terminal event, который идёт после effect event, видит уже применённые предыдущие изменения;
- malformed terminal event/failed earlier effect → whole-transition failure без state;
- уже terminal authoritative state не должен запускать новый normal interval без explicit policy.

### 4. Deadline projection

Добавить минимальный pure helper/definition, который создаёт `core.terminal` event на absolute deadline. Не использовать `Date` или wall-clock.

Опорная проверка: действие планировалось на 600 sec, deadline/terminal стоит на 300 sec → итоговый clock=300, terminal set, events после 300 не применены.

### 5. Deterministic RNG + provenance

Добавить маленький Core RNG interface/implementation:

- seed — explicit safe/uint32 value;
- никакого `Math.random`, `Date`, process entropy;
- одинаковый seed + одинаковая последовательность draw → одинаковые values;
- каждый draw возвращает provenance: algorithm/version, seed or stream id, draw index, raw/value;
- bounded integer draw (`nextInt(maxExclusive)`) без floating hidden state;
- invalid bound → failure/throw по одному чётко протестированному policy.

RNG пока не обязан автоматически создавать события; задача — создать детерминированный источник для следующих action/task rules.

## Приёмка

- clean `npm ci` + `npm run verify`;
- task projection deterministic и reference-safe;
- deadline на 300 прерывает planned action до 600 и ставит clock=300;
- event после terminal не применяется;
- effect перед terminal применяется, поздний effect после terminal — нет;
- terminal/clock/revision transition immutable;
- same RNG seed/draw sequence byte-for-byte repeatable;
- ни в Core, ни в contracts нет `Date`, timers, `Math.random`, HTTP/storage/LLM;
- generated capabilities публикуют только реально добавленные task/terminal types.

## Не делать

SQLite/runtime persistence, background worker loops, real-time countdowns, recurring cron, NPC AI decisions, network multiplayer, LLM-generated events или Studio UI.

## После приёмки

Сверить B03 целиком с каноническим B03/T05–06/T08. Если матрица закрыта — принять общий B03 и перейти к B04 persistent runtime/API/idempotency. Если обнаружится конкретный незакрытый инвариант, создать только bounded B03-04 под него.
