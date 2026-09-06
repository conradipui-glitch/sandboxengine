# Передача работы

Обновлено: 2026-09-06

Текущий блок: B03-01 — integer clock и ordered scheduler plan  
Базовый commit: `ec9b676cf1f424514204c51a63fa37fd3c6e8472`  
Последний кодовый commit перед docs: `fa3fb5e373e6ae95a55b26ff1e5b20fe61488582`  
Статус: accepted по bounded-приёмке; публикация выполняется через PR #8

## Выполнено

- Добавлен strict `ScheduledEvent` v1.0.
- Первый scheduler kind — `core.marker`; payload не может содержать arbitrary code/effects/statePatch.
- `atElapsedSeconds` и `order` — non-negative safe integers; `eventId` и `sourceId` bounded.
- Реализован чистый `planTimeAdvance(state, durationSeconds, events, options)`.
- Boundary semantics зафиксирована ADR 0007 как inclusive `[start,end]`.
- Event `< start` → `past_event`; event `> end` → pending.
- Event ровно в start/end входит в due plan.
- duration=0 может включить due-now event, но не future event.
- Deterministic sort: `atElapsedSeconds` → `order` → lexical `eventId`.
- Duplicate event ids, invalid event, unsafe duration/options и clock overflow — explicit failures.
- `maxEvents` bounded; limit failure не возвращает partial due plan.
- Planning не мутирует `WorldState`, не двигает clock/revision и не применяет effects.
- Generated agent kit публикует `scheduledEventKinds: ["core.marker"]`; HTTP operations по-прежнему отсутствуют.

## Проверено

GitHub Actions PR #8 run [34032426350](https://github.com/conradipui-glitch/sandboxengine/actions/runs/34032426350), Node `24.19.0`, npm `11.17.0`:

- `npm ci` → успешно;
- `npm run verify` → успешно;
- contract tests → 30/30 passed;
- Core tests → 34/34 passed;
- `check:boundaries` → успешно;
- `docs:check` → успешно.

Опорный B03-01 trace:

- clock start=0;
- duration=600;
- event at=300;
- plan end=600;
- event входит в `dueEvents`;
- authoritative state после planning всё ещё clock=0.

Дополнительно доказаны input-order independence, time/order/eventId tie-break, inclusive boundaries, zero-duration behavior, past-event failure, duplicate ids, event-limit whole-plan failure и safe integer overflow handling.

## Не выполнено / ограничения

- Due events пока не применяют gameplay effects.
- Clock/revision пока не меняются даже после успешного plan.
- Pending queue не хранится в WorldState/storage.
- NPC task lifecycle, recurring events, deadlines, interruption/resume, terminal conditions и RNG отсутствуют.
- Runtime API/storage/idempotency — B04.
- Wall-clock, `Date`, timers и background simulation намеренно отсутствуют.
- `npm ci` продолжает сообщать 2 dependency vulnerabilities (1 moderate, 1 high); force-upgrade не выполнялся.

## Следующее действие

После публикации PR #8 выполнить [B03-02 — event effects и чистый clock commit](tasks/B03-02-event-effects-and-clock-commit.md): добавить bounded effect-bearing event kind, применить due events строго по B03-01 plan через существующий `tryApplyEffectBatch`, доказать whole-transition atomicity и вернуть новый immutable state с clock=end/revision+1. Не добавлять persistence, HTTP или interruptions.

## Решения

- ADR 0003: executable GameplayEffect отдельно от generic Effect v1.0.
- ADR 0004: CalculatedAction отдельно от public transport ActionResult v1.0.
- ADR 0005: declarative Condition и mixed atomicity.
- ADR 0006: request, permission и response являются отдельными social semantics.
- ADR 0007: integer scheduler planning использует inclusive `[start,end]` и deterministic `time → order → eventId`.
