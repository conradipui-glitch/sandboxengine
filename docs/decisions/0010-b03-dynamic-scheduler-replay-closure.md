# ADR 0010 — closure B03: dynamic scheduler, fixed priorities и replay fingerprint

Статус: принято 2026-09-06.

## Контекст

После B03-03 task/deadline/terminal interruption и deterministic RNG были реализованы, но каноническая приёмка B03 из `docs/SPECIFICATION.md` всё ещё требовала точные T05/T06/T08 и same plan+seed replay/hash. Эти пробелы нельзя переносить в B04, потому что они относятся к причинности Core, а не к persistence/runtime.

## Решение

- `GameplayEffect:1.0` получает зарегистрированный strict variant `entity.move`. Он переносит только существующую entity в существующую location через общий atomic `tryApplyEffectBatch`; arbitrary state patch не вводится.
- Статический `planTimeAdvance` B03-01 остаётся неизменным. Dynamic child events обрабатывает отдельный `processTimeAdvancePlan` над trial state.
- Event handler является доверенной deterministic границей: получает frozen `WorldState` snapshot и может вернуть только strict `SchedulerEvent[]`.
- Generated child event нельзя поставить в прошлое или продублировать по ID. Child на том же timestamp получает effective priority не ниже parent и новый monotonic sequence.
- На весь transition действует один bounded `maxSteps/maxEvents`, включая generated events. Overflow/invalid child/handler failure возвращают failure без candidate state и без partial clock/revision commit.
- Приоритеты первого выпуска фиксированы в Core согласно §7.4: world event `10`, task/step completion `20`, deadline `100`. Synthetic task-start использует внутренний order `19`, чтобы zero-duration task start не оказался после completion. Эти числа не являются произвольной author policy.
- Terminal event останавливает dynamic processing в своём timestamp; более поздние due events остаются unprocessed.
- Replay fingerprint переиспользует единственный `canonicalStringify` проекта и SHA-256. В fingerprint входят версии, initial state, plan, RNG provenance, processed events/ordered effects и final state.

## Доказательство

Final PR #11 CI run `34034950071`, Node `24.19.0`, npm `11.17.0`:

- contract tests: 35/35 passed;
- Core tests: 55/55 passed;
- `check:boundaries`: passed;
- `docs:check`: passed.

Именованные regressions:

- T05: NPC возвращается на 900-й секунде внутри interval до 2400, а event на 1200 видит новую location;
- T06: completion и deadline на 86_500; priority `20` выполняется до `100`, integer clock пересекает 86_400 без `Date`/timezone;
- T08: self-generated immediate chain упирается в общий `maxSteps` и не отдаёт partial state/clock/revision;
- replay: одинаковые plan+seed/provenance дают одинаковые ordered effects, final state и SHA-256 hash; meaningful change меняет hash.

В изменённом Core отсутствуют `Math.random`, `Date` и timers. HTTP/storage/LLM не добавлялись.

## Следствия

Общий B03 считается принятым после зелёного merge/push CI. Следующий блок — B04 persistence/runtime/API/idempotency. B04 не должен переписывать scheduler semantics; он сохраняет и атомарно коммитит уже рассчитанный Core transition и replay data.
