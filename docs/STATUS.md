# Статус движка

Последнее обновление: 2026-09-06. Источник краткого статуса — этот файл; подробности и решения находятся по ссылкам.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий и навигация | B01/B02 приняты; B03-01/02 в `main`; B03-03 accepted bounded | B03-01 merge `e2605c3f24fd456fb11ed0b8dbcc3b00e97e3893`; B03-02 merge `9dbdc4e32ac6118cc665243a6cb8b6126bc26cc3`; B03-03 PR #10, final CI `34033842749` |
| Контракты | B03-03 добавил task/terminal без silent widening | `ScheduledTask:1.0` (`core.task`), отдельный `ScheduledTerminalEvent:1.0` (`core.terminal`); marker/effect contracts сохранены |
| Core action execution | B02 принят | read-only authoritative input, explicit resolver, trial effect batch, executed/partial/conditional/blocked |
| Resources/items | B02 принят | `resource.change`, `item.transfer`, mixed batch atomicity T07 |
| Conditions | B02 принят | resource/entity/item predicates + all/any/not; false отделён от broken reference |
| Player/social agency | B02 принят | request ≠ permission ≠ response; request conditional; accept/refuse explicit; no hidden physical effects |
| Scheduler planning | B03-01 принят | integer elapsedSeconds, inclusive `[start,end]`, deterministic `time → order → eventId`, explicit queue failures |
| Scheduler state transition | B03-02 принят | chronological typed effects, whole-transition atomicity, clock/revision commit |
| Tasks/deadlines/interruptions/RNG | B03-03 accepted bounded | task projection, terminal interruption, `unprocessedEvents`, explicit functional `lcg32-v1` RNG |
| Общий B03 | **ещё не принят** | canonical audit выявил bounded gaps T05/T06/T08 + replay hash; следующий срез [B03-04](tasks/B03-04-b03-matrix-closure.md) |
| Runtime/API/storage | не начато | B04 только после общей приёмки B03 |
| Studio/Player | не начато | B05/B07 |
| AI-провайдеры/свободный ввод | не начато | B06; модель должна отображать текст на уже существующие Core-смыслы |
| Плагины/Builder | не начато | B08/B13 |
| Миграция Florence | не начато | B11 |

## Что движок умеет после B03-03

Поверх B02 и B03-01/02 Core теперь умеет без storage/LLM:

- проектировать strict NPC task в deterministic start/completion events;
- валидировать actor reference и целочисленное absolute task time;
- создавать отдельный terminal/deadline event без arbitrary state patch;
- применять effect events по хронологии и прерывать interval в terminal timestamp;
- сохранить эффекты, случившиеся до terminal, не применять более поздние и вернуть их как `unprocessedEvents`;
- поставить resulting clock на terminal time и увеличить revision один раз;
- запретить новый normal interval из уже terminal authoritative state;
- генерировать repeatable bounded integers через explicit immutable `lcg32-v1` RNG state с provenance;
- публиковать только реально реализованные `core.effects`, `core.marker`, `core.terminal` и `core.task` в generated capabilities.

Опорная B03-03 регрессия: interval 0→600; effect@200 применяется; deadline@300 ставит terminal и обрывает interval; effect@400 не применяется; final clock=300, revision 7→8.

Final PR #10 CI `34033842749`: `npm ci` + `npm run verify` passed; contract tests 34/34, Core tests 47/47, boundaries/docs gate зелёные.

## Почему общий B03 ещё открыт

Каноническая матрица требует точных T05/T06/T08 и replay/hash:

- **T05:** NPC возвращается на 900-й секунде внутри работы до 2400-й; последующие шаги должны видеть новое location-state. Текущий effect vocabulary ещё не имеет typed entity movement.
- **T06:** task completion ровно при deadline должен быть обработан первым; отдельно нужен regression crossing-midnight на integer clock.
- **T08:** self-generated immediate event должен упереться в общий step/event budget без partial commit. B03-01 ограничивает статическую due queue, но dynamic child-event processing ещё отсутствует.
- B03 card требует одинаковый plan+seed → одинаковые effects и hash; RNG есть, scheduler replay fingerprint ещё нет.

Следующий и только следующий срез — [B03-04](tasks/B03-04-b03-matrix-closure.md). B04 пока не открывать.

Известное наблюдение CI: `npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high); force-upgrade без отдельной проверки не выполнялся.
