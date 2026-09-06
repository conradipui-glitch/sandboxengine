# Статус движка

Последнее обновление: 2026-09-06. Источник краткого статуса — этот файл; подробности и решения находятся по ссылкам.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий и навигация | B01 и общий B02 приняты; B03-01 реализован | B02-03 merge `2bb15df2f5bb493828ea59c796e776cf01e259fc`; B02-04 merge `ec9b676cf1f424514204c51a63fa37fd3c6e8472`; B03-01 PR #8, CI `34032426350` |
| Контракты | B03-01 добавил scheduler contract | strict `GameplayEffect`, `Condition`, `SocialAct`, `CalculatedAction`, `ScheduledEvent` v1.0; generated capabilities current |
| Core action execution | B02 принят | read-only authoritative input, explicit resolver, trial effect batch, executed/partial/conditional/blocked |
| Resources/items | B02 принят | `resource.change`, `item.transfer`, mixed batch atomicity T07 |
| Conditions | B02 принят | resource/entity/item predicates + all/any/not; false отделён от broken reference |
| Player/social agency | B02 принят | request ≠ permission ≠ response; request conditional; accept/refuse explicit; no hidden physical effects |
| Scheduler planning | B03-01 accepted по bounded-приёмке | integer elapsedSeconds, `ScheduledEvent`, inclusive `[start,end]`, deterministic order, past/limit/overflow failures |
| Scheduler application/tasks | следующий срез | B03-02 — event effects + чистый clock/revision transition; B03-03 — tasks/deadlines/interruptions/terminal/RNG |
| Runtime/API/storage | не начато | B04 после общего B03 |
| Studio/Player | не начато | B05/B07 |
| AI-провайдеры/свободный ввод | не начато | B06; модель должна отображать текст на уже существующие Core-смыслы |
| Плагины/Builder | не начато | B08/B13 |
| Миграция Florence | не начато | B11 |

## Что движок умеет после B03-01

B02 invariants остаются принятыми: explicit action resolution, conditions, atomic effects и social/player-agency semantics.

Новый scheduler planning layer умеет без wall-clock:

- взять authoritative `WorldState.clock.elapsedSeconds` и рассчитанную duration;
- безопасно вычислить integer interval `[start,end]`;
- провалиться на past event, duplicate id, unsafe integer, clock overflow или event-limit;
- отсортировать события независимо от input order по `time → order → eventId`;
- включить событие ровно в start/end согласно inclusive semantics;
- оставить событие после end pending;
- при duration=0 не затронуть будущие события;
- вернуть plan, не изменяя authoritative state.

Опорная регрессия B03-01: action duration=600 sec, event at=300 sec → event находится в due plan раньше action end; исходный clock при planning остаётся 0.

## Что B03-01 ещё не делает

- event effects не применяются;
- `WorldState.clock` и revision не коммитятся;
- очередь не хранится;
- NPC tasks/deadlines/interruptions/terminal/RNG отсутствуют.

Следующий шаг — [B03-02](tasks/B03-02-event-effects-and-clock-commit.md).

Известное наблюдение CI: `npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high); force-upgrade без отдельной проверки не выполнялся.
