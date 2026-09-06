# Передача работы

Обновлено: 2026-09-06

Текущий блок: B03-02 — scheduled effects и atomic clock transition  
Базовый commit: `e2605c3f24fd456fb11ed0b8dbcc3b00e97e3893`  
Последний кодовый commit перед docs: `06a8d3d39cedcbafbf067aa0c2bd3db9f87e67b6`  
Статус: accepted по bounded-приёмке; публикация выполняется через PR #9

## Выполнено

- B03-01 marker-only `ScheduledEvent:1.0` не расширялся задним числом.
- Добавлен отдельный strict `ScheduledEffectEvent:1.0`, kind `core.effects`, bounded non-empty `GameplayEffect[]`.
- Core использует union `SchedulerEvent = ScheduledEvent | ScheduledEffectEvent`.
- `planTimeAdvance` поддерживает оба event contract и сохраняет inclusive `[start,end]` + deterministic ordering.
- Реализован `applyTimeAdvancePlan`.
- Plan обязан начинаться с authoritative state clock; malformed/unsorted plan и mismatch отклоняются.
- Due effect events применяются строго по plan order через существующий B02 `tryApplyEffectBatch`.
- Marker event остаётся trace/no-op.
- Более поздний event видит state после более раннего event.
- Если поздний event effect падает, весь scheduler transition возвращает failure без state; earlier trial state наружу не коммитится.
- На полном success clock становится `plan.endElapsedSeconds`, revision увеличивается ровно один раз.
- Zero-duration committed transition сохраняет clock и увеличивает revision один раз.
- Pending events возвращаются отдельно и не применяются преждевременно.
- Generated agent kit публикует `core.effects` и `core.marker` как два scheduler capabilities с двумя отдельными schema IDs.
- Решение зафиксировано ADR 0008.

## Проверено

GitHub Actions PR #9 run [34032919106](https://github.com/conradipui-glitch/sandboxengine/actions/runs/34032919106), Node `24.19.0`, npm `11.17.0`:

- `npm ci` → успешно;
- `npm run verify` → успешно;
- contract tests → 32/32 passed;
- Core tests → 40/40 passed;
- `check:boundaries` → успешно;
- `docs:check` → успешно.

### Chronology regression

- initial `blue_paint=2`;
- input #1: spend `-4` at 400 sec;
- input #2: delivery `+2` at 300 sec;
- planner sorts delivery before spend;
- scheduler applies +2 then -4;
- final paint=0, clock=600, revision 7→8.

### Whole-transition atomicity

- event A at 300: paint +2 succeeds on trial;
- event B at 400: item transfer to missing holder fails;
- result: `event_effect_failed`, nested `holder_not_found`, no state field;
- authoritative paint remains 2, item remains at original location.

## Не выполнено / ограничения

- Task definitions/lifecycle отсутствуют.
- Deadline/terminal interruption отсутствует.
- Long action пока не обрывается ранним terminal event.
- Deterministic RNG/provenance отсутствует.
- Queue/state persistence и idempotent runtime commit относятся к B04.
- Никаких `Date`, wall-clock timers, HTTP/storage/LLM в Core нет.
- `npm ci` продолжает сообщать 2 dependency vulnerabilities (1 moderate, 1 high); force-upgrade не выполнялся.

## Следующее действие

После публикации PR #9 выполнить [B03-03 — tasks, deadlines, interruptions и deterministic RNG](tasks/B03-03-tasks-deadlines-interruptions-rng.md). Этот срез должен доказать deadline interrupt длинного interval и deterministic task/RNG behavior по T05–06/T08. После него сверить общий B03 с канонической матрицей; не переходить к B04, если останется конкретный незакрытый B03-инвариант.

## Решения

- ADR 0003: executable GameplayEffect отдельно от generic Effect v1.0.
- ADR 0004: CalculatedAction отдельно от public transport ActionResult v1.0.
- ADR 0005: declarative Condition и mixed atomicity.
- ADR 0006: request, permission и response — разные social semantics.
- ADR 0007: integer scheduler planning использует inclusive `[start,end]` и deterministic `time → order → eventId`.
- ADR 0008: effect-bearing scheduler events имеют отдельный strict contract; весь time interval — один atomic Core transition.
