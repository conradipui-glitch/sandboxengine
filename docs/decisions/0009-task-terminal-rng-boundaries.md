# ADR 0009 — task projection, terminal interruption и explicit RNG

Дата: 2026-09-06  
Статус: accepted для B03-03

## Контекст

После B03-01/02 Core уже умел планировать integer-time interval и атомарно применять effect-bearing scheduler events. Для B03-03 требовались NPC tasks, deadline/terminal interruption и воспроизводимая случайность, но без storage, wall-clock, background loops или LLM.

Нельзя было расширять задним числом уже опубликованные strict `ScheduledEvent:1.0` и `ScheduledEffectEvent:1.0` новыми несовместимыми полями.

## Решение

1. Task является отдельным strict authoring/runtime contract `ScheduledTask:1.0`, kind `core.task`.
2. Task не меняет мир сам: pure `projectTaskEvents(state, task)` проверяет actor/time и детерминированно создаёт start/completion scheduler events со stable IDs/order.
3. Terminal/deadline является отдельным strict `ScheduledTerminalEvent:1.0`, kind `core.terminal`.
4. Terminal event внутри due interval — успешное причинное прерывание, а не техническая ошибка:
   - события до terminal применяются;
   - `WorldState.terminal` устанавливается в terminal event;
   - clock фиксируется на времени terminal, а не на исходном `plan.end`;
   - revision увеличивается один раз;
   - более поздние due events возвращаются как `unprocessedEvents` и не применяются.
5. Уже terminal authoritative state не начинает новый normal interval без отдельной будущей policy.
6. RNG — чистый функциональный Core API `lcg32-v1`: caller передаёт explicit immutable state (`seed`, `streamId`, `drawIndex`, internal uint32 state), каждый draw возвращает новый RNG state и provenance. `Math.random`, `Date`, process entropy и скрытый mutable singleton запрещены.
7. Generated capabilities отдельно публикуют `core.terminal` и `core.task`; planned HTTP operations по-прежнему не считаются available.

## Почему так

- Старые schema IDs сохраняют прежний смысл.
- Task definition отделён от факта исполнения и может позже храниться/восстанавливаться B04 без зависимости Core от БД.
- Terminal interruption становится проверяемой частью причинности: длинное действие не может «доиграть» события после финала.
- Explicit RNG позволяет replay: одинаковый вход и cursor дают одинаковую последовательность без зависимости от процесса.

## Последствия и границы

B03-03 не реализует dynamic event spawning/step budget, реальное перемещение NPC как gameplay effect и replay hash. Каноническая сверка B03 показала, что они нужны для точных T05/T06/T08; они вынесены в bounded B03-04, а не добавлены скрытым scope creep в B03-03.

Storage/idempotency/Runtime API остаются B04. Background realtime, timers и LLM в Core не добавляются.
