# Статус движка

Последнее обновление: 2026-09-06. Источник краткого статуса — этот файл; подробности и решения находятся по ссылкам.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий и навигация | B01/B02 приняты; B03-01 и B03-02 реализованы | B03-01 merge `e2605c3f24fd456fb11ed0b8dbcc3b00e97e3893`; B03-02 PR #9, CI `34032919106` |
| Контракты | B03-02 расширил scheduler без silent widening | marker-only `ScheduledEvent:1.0` сохранён; новый `ScheduledEffectEvent:1.0`; generated capabilities current |
| Core action execution | B02 принят | read-only authoritative input, explicit resolver, trial effect batch, executed/partial/conditional/blocked |
| Resources/items | B02 принят | `resource.change`, `item.transfer`, mixed batch atomicity T07 |
| Conditions | B02 принят | resource/entity/item predicates + all/any/not; false отделён от broken reference |
| Player/social agency | B02 принят | request ≠ permission ≠ response; request conditional; accept/refuse explicit; no hidden physical effects |
| Scheduler planning | B03-01 принят | integer elapsedSeconds, inclusive `[start,end]`, deterministic `time → order → eventId`, explicit queue failures |
| Scheduler state transition | B03-02 accepted по bounded-приёмке | `core.effects` через отдельный strict contract; chronological effect application; whole-transition atomicity; clock=end/revision+1 |
| Tasks/deadlines/interruptions/RNG | следующий срез | [B03-03](tasks/B03-03-tasks-deadlines-interruptions-rng.md); после него сверить общий B03/T05–06/T08 |
| Runtime/API/storage | не начато | B04 после общего B03 |
| Studio/Player | не начато | B05/B07 |
| AI-провайдеры/свободный ввод | не начато | B06; модель должна отображать текст на уже существующие Core-смыслы |
| Плагины/Builder | не начато | B08/B13 |
| Миграция Florence | не начато | B11 |

## Что движок умеет после B03-02

Поверх принятых B02 invariants scheduler теперь умеет:

- построить детерминированный integer-time plan независимо от порядка input-массива;
- различить marker event и отдельный effect-bearing event contract;
- применять due `GameplayEffect` по хронологии через единый B02 `tryApplyEffectBatch`;
- дать более позднему событию увидеть state после более раннего;
- отклонить весь scheduler transition, если поздний event effect падает, без возврата partial state;
- на полном success вернуть immutable state с clock=`plan.end` и revision+1 ровно один раз;
- вернуть future pending events без преждевременного применения;
- проверить plan/state mismatch, malformed ordering и revision overflow.

Опорная chronology-регрессия: initial paint=2; input содержит spend -4 at 400 раньше delivery +2 at 300. Планировщик переставляет события по времени: +2 → -4; final paint=0, clock=600, revision 7→8.

Опорная atomicity-регрессия: +2 at 300 успешно на trial, затем item transfer к missing holder at 400 падает; result без state, authoritative input остаётся неизменённым.

## Что ещё не делает общий B03

- нет task definitions/lifecycle;
- deadline пока не является terminal interruption;
- terminal event не обрывает длинное действие;
- deterministic RNG/provenance ещё отсутствует;
- очередь/state не сохраняются между HTTP-запросами — это B04.

Следующий шаг — [B03-03](tasks/B03-03-tasks-deadlines-interruptions-rng.md).

Известное наблюдение CI: `npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high); force-upgrade без отдельной проверки не выполнялся.
