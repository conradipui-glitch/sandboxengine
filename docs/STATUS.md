# Статус движка

Последнее обновление: 2026-09-06. Источник краткого статуса — этот файл; подробности и решения находятся по ссылкам.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий и навигация | B01/B02/B03 приняты | B03-03 merge `53285ba13407c19678ef8f5163dadb63dad83b86`; B03-04 PR #11, final CI `34034950071`; ADR 0010 |
| Контракты | B03 принят | strict scheduler/task/terminal contracts; `GameplayEffect:1.0` зарегистрировал `entity.move`; generated capabilities current |
| Core action execution | B02 принят | read-only authoritative input, explicit resolver, trial effect batch, executed/partial/conditional/blocked |
| Resources/items/entities | B03 принят | `resource.change`, `item.transfer`, `entity.move`; mixed batch atomicity |
| Conditions | B02 принят | resource/entity/item predicates + all/any/not; false отделён от broken reference |
| Player/social agency | B02 принят | request ≠ permission ≠ response; request conditional; accept/refuse explicit; no hidden physical effects |
| Scheduler planning | B03 принят | integer elapsedSeconds, inclusive `[start,end]`, deterministic static order, explicit queue failures |
| Scheduler processing | B03 принят | chronological typed effects, dynamic child events, global step/event budget, terminal interruption, whole-transition atomicity |
| Tasks/deadlines | B03 принят | deterministic task projection, fixed first-release priorities: world 10, completion 20, deadline 100 |
| Deterministic RNG/replay | B03 принят | explicit immutable `lcg32-v1` provenance + canonical SHA-256 replay fingerprint |
| Runtime/API/storage | **следующий блок B04; не начато** | persistence, operation claim/lease/fencing, atomic commit, Runtime API, T10–12/T15 |
| Studio/Player | не начато | B05/B07 |
| AI-провайдеры/свободный ввод | не начато | B06; модель отображает текст поверх уже рассчитанных Core-смыслов |
| Плагины/Builder | не начато | B08/B13 |
| Миграция Florence | не начато | B11 |

## Что принято в общем B03

Поверх B02 invariants Core теперь умеет без storage/LLM:

- считать игровое время только целыми elapsed seconds; `Date`/timezone/wall-clock не участвуют;
- строить static interval plan с детерминированным порядком и bounded event count;
- применять typed effect events хронологически на trial state и коммитить clock/revision один раз;
- проектировать strict NPC task в deterministic start/completion events;
- переносить существующую entity в существующую location через atomic `entity.move`;
- создавать deadline/terminal event и прерывать длинный interval в точном terminal timestamp;
- оставлять late due events после terminal как `unprocessedEvents`;
- обрабатывать deterministic generated child events через отдельный `processTimeAdvancePlan`, не меняя B03-01 static planner;
- запрещать child в прошлое, duplicate/invalid child и отклонять transition без partial state;
- ограничивать initial + generated processing одним `maxSteps/maxEvents`;
- обеспечивать same-time причинность через effective priority + monotonic sequence;
- использовать фиксированную first-release priority policy: world `10`, task/step completion `20`, deadline `100`; synthetic task-start internal order `19`;
- генерировать repeatable bounded integers через explicit immutable `lcg32-v1` RNG state с provenance;
- строить deterministic replay fingerprint на существующем `canonicalStringify` + SHA-256.

## Каноническая B03-матрица

Final PR #11 CI run `34034950071`, Node `24.19.0`, npm `11.17.0`:

- contract tests: 35/35 passed;
- Core tests: 55/55 passed;
- `check:boundaries`: passed;
- `docs:check`: passed.

Прямые доказательства:

- **T05:** NPC возвращается at=900 внутри работы до 2400; event at=1200 видит новую location;
- **T06:** completion и deadline оба at=86_500; canonical priority `20` выполняется до `100`; integer clock пересекает 86_400 однозначно;
- **T08:** self-generated immediate chain упирается в общий step budget и не возвращает partial state/clock/revision;
- **Replay:** same plan+seed/provenance даёт одинаковые ordered effects, final state и SHA-256 hash; meaningful change меняет hash.

В изменённом Core отсутствуют `Math.random`, `Date` и timers. HTTP/storage/LLM в B03 не добавлялись.

Решение зафиксировано ADR 0010. После зелёного merge/push CI PR #11 общий B03 считается окончательно опубликованным в `main`.

## Следующая точка — B04

B04 начинается только от проверенного `main` после merge PR #11. Его задача — **сохранять и атомарно публиковать уже рассчитанный Core transition, а не переписывать причинность B03**.

Канонический B04 scope:

- Memory/SQLite storage contract;
- `claimOperation(sessionId, key, requestHash, expectedRevision)`;
- lease + monotonic fencing token;
- atomic `commitTurn` состояния, turn record и public response;
- idempotency/recovery после потерянного ответа;
- Runtime API и безопасная player projection;
- T10–12/T15.

Не начинать Studio/AI/Florence migration раньше соответствующих блоков.

Известное наблюдение CI: `npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high); force-upgrade без отдельной проверки не выполнялся.
