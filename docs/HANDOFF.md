# Передача работы

Обновлено: 2026-09-06

Текущий блок: B03-03 — tasks, deadlines, interruptions, deterministic RNG  
Базовый commit: `9dbdc4e32ac6118cc665243a6cb8b6126bc26cc3`  
Последний functional/docs commit перед финальным gate: `1919b6cc6f54799e8327161bdf4c3508f5b2f37d`  
Статус: accepted по bounded-приёмке; публикация через PR #10; общий B03 **ещё не принят** из-за конкретных gaps T05/T06/T08/replay hash

## Выполнено в B03-03

- Добавлен strict `ScheduledTask:1.0`, kind `core.task`.
- `projectTaskEvents(state, task)` проверяет actor reference, safe integer time, `complete >= start` и возвращает deterministic start/completion events со stable IDs/order; authored task не мутируется.
- Добавлен отдельный strict `ScheduledTerminalEvent:1.0`, kind `core.terminal`; существующие `ScheduledEvent:1.0` и `ScheduledEffectEvent:1.0` не widened.
- `projectDeadlineEvent(...)` создаёт bounded terminal event по absolute elapsed seconds без `Date`/wall-clock.
- `SchedulerEvent` включает marker/effects/terminal.
- `applyTimeAdvancePlan` трактует terminal как успешное interruption:
  - previous effect events применяются;
  - `WorldState.terminal` устанавливается;
  - clock фиксируется на terminal timestamp, не `plan.end`;
  - revision увеличивается ровно один раз;
  - later due events не выполняются и возвращаются как `unprocessedEvents`.
- Уже terminal authoritative state получает explicit `already_terminal` для нового normal interval/apply.
- Добавлен functional RNG `lcg32-v1`: explicit immutable seed/stream/drawIndex/state, bounded integer draw, provenance; без `Math.random`, `Date` или process entropy.
- Generated capabilities публикуют `core.effects`, `core.marker`, `core.terminal`, task kind `core.task`; HTTP operations остаются 0.
- Решение зафиксировано ADR 0009.

## Проверено

Первый PR #10 run `34033798512`:

- typecheck — passed;
- contract tests — 34/34 passed;
- Core tests — 47/47 passed;
- boundaries — passed;
- `docs:check` нашёл только byte-format mismatch ручного `schema-index.json`.

После приведения generated formatting к output генератора второй PR run `34033842749` полностью прошёл `npm ci` + `npm run verify`.

Ключевые regressions:

- task projection детерминирован и actor-reference-safe;
- interval 0→600: effect@200 → terminal@300 → effect@400; final clock=300, terminal set, late event не применён;
- terminal state блокирует новый normal interval;
- same RNG seed/draw sequence даёт byte-for-byte одинаковые values/provenance;
- invalid seed/bound/draw overflow explicit.

## Каноническая сверка общего B03

По `docs/SPECIFICATION.md` B03 требует T05–06/T08, same plan+seed deterministic effects/hash, задачи NPC, generated-event step limit и однозначную same-time причинность.

После B03-03 остаются **ровно следующие bounded gaps**:

1. **T05 / entity movement.** Нужен typed `entity.move` (или минимальный эквивалент) в GameplayEffect + exact regression: NPC возвращается at=900 внутри interval до 2400, а последующий step видит его уже в workshop.
2. **T06 / same timestamp + midnight.** Нужно доказать task completion и deadline на одном timestamp с completion-first order; integer clock должен однозначно пройти 86_400 без timezone/Date.
3. **T08 / generated child events.** Нужен deterministic processing sequence и общий step budget для events, порождённых обработчиком; self-generating immediate event должен завершиться explicit limit failure без partial candidate state.
4. **Replay hash.** Same plan+seed+versions должен давать одинаковые ordered effects/final state fingerprint; meaningful input/seed change — другой hash.

Эти пункты оформлены как [B03-04](tasks/B03-04-b03-matrix-closure.md). Не смешивать их с persistence/API B04.

## Следующее действие

После merge PR #10 создать ветку от проверенного `main` и выполнить **только B03-04**. Не открывать B04, пока exact T05/T06/T08 и replay/hash не пройдут clean CI и повторную canonical сверку.

## Решения

- ADR 0003: executable GameplayEffect отдельно от generic Effect v1.0.
- ADR 0004: CalculatedAction отдельно от public transport ActionResult v1.0.
- ADR 0005: declarative Condition и mixed atomicity.
- ADR 0006: request, permission и response — разные social semantics.
- ADR 0007: inclusive integer scheduler planning и deterministic static order.
- ADR 0008: effect-bearing events — отдельный strict contract; whole interval atomic.
- ADR 0009: task projection, separate terminal interruption и explicit functional RNG.

## Ограничения

- Queue/task persistence, operation idempotency, leases/fencing, Runtime API — B04.
- Background realtime/timers отсутствуют намеренно.
- LLM/NPC decisions отсутствуют.
- `npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high); force-upgrade без отдельной проверки не выполнялся.
