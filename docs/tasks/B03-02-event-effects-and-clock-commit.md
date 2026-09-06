# B03-02 — event effects и чистый clock commit

## Цель

Поверх принятого B03-01 plan добавить первый чистый state-transition scheduler: due events должны применяться строго в принятом хронологическом порядке, а успешный интервал завершаться новым immutable `WorldState` с clock=end и revision+1. Пока без persistence, interruptions и полноценного NPC task subsystem.

## Вход

- B03-01 accepted;
- `planTimeAdvance` задаёт inclusive `[start,end]`, due/pending и deterministic order;
- B02 `tryApplyEffectBatch` гарантирует typed all-or-nothing resource/item effects;
- authoritative input state read-only.

## Сделать

1. Расширить scheduler event contract вторым bounded event kind, который несёт только `GameplayEffect[]`, например `core.effects`:
   - no arbitrary state patch/code;
   - effects обязаны проходить существующий strict `GameplayEffect` contract;
   - marker event остаётся no-op для state.
2. Реализовать чистый `applyTimeAdvancePlan(state, plan)` или эквивалентный transition:
   - проверить, что plan начинается с текущего authoritative clock;
   - применить due events по order из plan;
   - каждый event effect batch проходит `tryApplyEffectBatch`;
   - следующий event видит state после предыдущего event;
   - если любой event не применяется, весь scheduler transition возвращает failure **без итогового state**;
   - на полном success вернуть новый state с `clock.elapsedSeconds=end` и `revision=revision+1`.
3. Не изменять pending events в state — очередь пока остаётся внешним input; вернуть их отдельно как remainder/result.
4. Доказать chronology:
   - event A at 300 меняет ресурс;
   - event B at 400 использует уже изменённый ресурс;
   - порядок input-массива не влияет, действует plan B03-01.
5. Доказать atomic scheduler transition:
   - event A успешно меняет resource;
   - event B имеет invalid item transfer/resource bound;
   - итог failure не возвращает partially advanced state, authoritative input не изменён.
6. Clock/revision invariants:
   - successful duration advances clock exactly to plan.end;
   - revision increments exactly once за весь interval, не за event;
   - duration=0 success остаётся clock=start, но revision policy должна быть явно зафиксирована тестом;
   - overflow revision/clock → explicit failure.
7. Marker events могут появляться в trace, но не менять state.
8. Обновить generated scheduler capabilities только для реально исполняемого второго event kind.

## Приёмка

- clean `npm ci` + `npm run verify`;
- event application chronology покрыта;
- whole-transition failure не даёт partial state;
- authoritative input неизменяем;
- clock/end и revision policy протестированы;
- B02 effect atomicity переиспользуется, не дублируется альтернативным мутатором;
- Core всё ещё без HTTP/storage/Date/timers/LLM.

## Не делать

SQLite/runtime commit, idempotency, recurring tasks, NPC autonomous decisions, deadline terminal rules, interruption/resume action, deterministic RNG, real-time timers или background simulation.

## Следом

B03-03: task lifecycle, deadlines, interruption/terminal semantics и deterministic RNG/provenance по T05–06/T08. Только после этого оценивать общий B03 как завершённый.
