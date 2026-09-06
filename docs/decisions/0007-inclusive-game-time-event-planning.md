# ADR 0007 — inclusive integer game-time event planning

Статус: accepted  
Дата: 2026-09-06

## Контекст

B02 рассчитывает `CalculatedAction.durationSeconds`, но намеренно не двигает `WorldState.clock`. B03 должен добавить хронологию так, чтобы событие, наступившее внутри длительного действия, обрабатывалось раньше окончания этого действия. Нельзя опираться на wall-clock, `Date`, таймеры процесса или порядок элементов входного массива.

До task lifecycle и event effects нужен минимальный чистый слой, который отвечает только на вопрос: какие события относятся к данному интервалу игрового времени и в каком порядке они должны рассматриваться.

## Решение

1. Authoritative clock остаётся целым `WorldState.clock.elapsedSeconds`.
2. `ScheduledEvent` v1.0 использует абсолютный `atElapsedSeconds`, stable `eventId`, non-negative safe-integer `order`, `sourceId`, bounded `kind` и typed payload.
3. Первый event kind — только `core.marker`; он не содержит gameplay effects, arbitrary code или state patch.
4. `planTimeAdvance` является чистой read-only функцией. Она не коммитит clock/revision и не применяет effects.
5. Интервал B03-01 — **inclusive `[start, end]`**:
   - `at < start` → `past_event` failure;
   - `start <= at <= end` → event due в текущем plan;
   - `at > end` → pending;
   - при `duration=0` event ровно в `start` может быть due, но будущий event не затрагивается.
6. Порядок детерминирован: `atElapsedSeconds`, затем `order`, затем lexical `eventId`.
7. Duplicate `eventId` запрещён в одной очереди планирования.
8. Числа проверяются через safe-integer semantics; clock overflow является failure.
9. `maxEvents` bounded. Превышение лимита отклоняет весь plan без частичного due-list.

## Почему не полуинтервал

Для первого scheduler slice событие, назначенное точно на момент окончания действия, должно быть частью того же хронологического окна: сначала строится единый упорядоченный plan, а будущий B03-02/B03-03 уже определит application/interruption semantics. Это устраняет неявный дополнительный tick после каждого действия.

## Последствия

- Один и тот же набор событий даёт один и тот же plan независимо от порядка входного массива.
- Сломанная очередь не маскируется как «событие просто пропущено».
- B03-02 может безопасно строить применение effects поверх уже принятого порядка, не меняя boundary semantics.
- B03-01 сам по себе не означает, что события уже исполняются или что часы сохранены.
