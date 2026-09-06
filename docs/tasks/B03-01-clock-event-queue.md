# B03-01 — integer clock и ordered scheduler plan

## Цель

Начать B03 с минимального чистого scheduler-ядра: рассчитанная duration должна представляться как целочисленный интервал игрового времени, а события внутри него — обрабатываться строго хронологически с детерминированным tie-break. Пока без storage commit, NPC task lifecycle и deadline semantics.

## Вход

- общий B02 принят;
- `WorldState.clock.elapsedSeconds` — authoritative integer clock;
- `CalculatedAction.durationSeconds` — уже рассчитанная длительность действия, но B02 её не применяет;
- раздел B03 канонического ТЗ: scheduler отвечает за хронологические события внутри действия.

## Сделать

1. Ввести strict versioned `ScheduledEvent`/scheduler input contract минимум с:
   - stable `eventId`;
   - `atElapsedSeconds` как non-negative safe integer;
   - deterministic `order`/sequence как non-negative safe integer;
   - provenance/sourceId;
   - bounded event kind/payload для первого тестового события без arbitrary executable code.
2. Зафиксировать deterministic sort: сначала `atElapsedSeconds`, затем `order`, затем stable `eventId` как последний tie-break.
3. Реализовать чистый `planTimeAdvance(state, durationSeconds, events, options)`:
   - state read-only;
   - duration — safe non-negative integer;
   - вычислить interval `[start, end]` с безопасной арифметикой;
   - выбрать только события, которые должны произойти в интервале согласно явно записанной boundary semantics;
   - вернуть ordered plan/trace, но пока не делать storage commit и не применять gameplay effects.
4. Явно определить границы:
   - событие раньше текущего clock → invalid/past-event failure, а не молчаливый пропуск;
   - событие после end → остаётся pending и не входит в executed list;
   - событие ровно в end должно иметь однозначно протестированную семантику;
   - duration=0 не должен случайно «съедать» будущие события.
5. Ввести bounded maximum events per interval, чтобы один план не обрабатывал бесконечную очередь. Переполнение → explicit failure/limit result, не частичный скрытый plan.
6. Доказать детерминизм:
   - один и тот же input → идентичный ordered plan;
   - перестановка входного массива не меняет порядок результата;
   - одинаковый timestamp разрешается через order/eventId.
7. Добавить первый regression на «событие происходит внутри длительного действия раньше его завершения»: например action duration 600 sec, event at +300 → scheduler plan показывает event before action end.
8. Обновить schemas, tests и generated capabilities только для реально реализованного scheduler contract.

## Приёмка

- `npm run verify` на clean runner;
- safe integer/overflow cases покрыты;
- past event не игнорируется;
- future event не исполняется преждевременно;
- event at action end имеет фиксированную тестом boundary semantics;
- input array order не влияет на результат;
- event limit не приводит к partial silent execution;
- Core не импортирует timer APIs, Date, HTTP, storage или LLM.

## Не делать

NPC tasks, recurring events, deadline/terminal conditions, event effects, interruption/resume action, RNG, persistence, HTTP, background wall-clock simulation или real-time timers.

## Следом

B03-02 должен добавить task/event lifecycle и effect application по хронологическому plan, после чего отдельным срезом — deadlines/interruptions/terminal/RNG. Не объявлять B03 готовым по одной очереди событий.
