# ADR 0008 — scheduled effects и атомарный clock transition

Статус: accepted  
Дата: 2026-09-06

## Контекст

B03-01 опубликовал strict marker-only `ScheduledEvent:1.0` и чистый `planTimeAdvance`. Следующий слой должен позволить событию менять authoritative world через уже существующие typed `GameplayEffect`, а затем продвигать игровой clock/revision. При этом нельзя:

- молча расширять опубликованный strict schema ID `ScheduledEvent:1.0`;
- создавать второй механизм state mutation в обход B02;
- коммитить часть ранних событий, если позднее событие интервала оказалось невалидным.

## Решение

1. Marker-only `ScheduledEvent:1.0` остаётся без изменений.
2. Effect-bearing события публикуются отдельным strict контрактом `ScheduledEffectEvent:1.0` с собственным `$id`.
3. `ScheduledEffectEvent` допускает только kind `core.effects` и bounded non-empty `GameplayEffect[]`; arbitrary code/statePatch запрещены.
4. Core объединяет два опубликованных контракта только через runtime union `SchedulerEvent = ScheduledEvent | ScheduledEffectEvent`.
5. B03-01 `planTimeAdvance` сохраняет прежние inclusive `[start,end]` и deterministic `time → order → eventId` semantics для обоих event kind.
6. `applyTimeAdvancePlan` получает authoritative state и уже построенный plan:
   - plan.start обязан совпадать с текущим clock;
   - malformed/unsorted plan отклоняется;
   - marker event — no-op для world state;
   - effect event применяет batch только через B02 `tryApplyEffectBatch`;
   - следующий event видит state после предыдущего event.
7. Весь time interval является одним Core transition: если любой поздний event batch падает, result не содержит state и никакой intermediate state не считается коммитом.
8. На полном success новый immutable state получает `clock.elapsedSeconds = plan.endElapsedSeconds` и `revision = previous revision + 1` ровно один раз за interval.
9. Zero-duration transition, если caller его сознательно коммитит, сохраняет clock и увеличивает revision один раз. Blocked/неисполняемые действия не должны вызывать этот commit layer.
10. Pending events пока остаются внешней очередью и возвращаются отдельно; persistence относится к B04.

## Последствия

- Версионная совместимость B03-01 сохраняется.
- Все resource/item mutation используют единственный B02 effect path.
- Хронология событий отделена от input order.
- Атомарность существует на двух уровнях: внутри одного effect batch и вокруг всего scheduler interval.
- B03-03 может добавить task/deadline/interruption/terminal semantics, не меняя базовый clock/effect commit.
