# Контекст для агента

Это короткая человеческая точка входа. Сначала прочитай [README](../../README.md), [STATUS](../STATUS.md), [HANDOFF](../HANDOFF.md) и карточку текущей задачи. Полное ТЗ — [docs/SPECIFICATION.md](../SPECIFICATION.md). Машинно собранный текущий контракт находится в [SKILL.md](SKILL.md).

## Текущая лестница причинности

Не смешивай разные обязанности:

1. `ResolvedIntent` — что понял ввод; без duration/effects/state mutation.
2. `Condition` — чистая проверка предпосылки по authoritative `WorldState`.
3. Action/social resolver — что реально возможно и какой смысл имеет explicit действие.
4. `CalculatedAction` — строгий рассчитанный outcome.
5. `tryApplyEffectBatch` — all-or-nothing typed world mutation на trial state.
6. `planTimeAdvance` — B03-01: static integer interval и deterministic event order.
7. `applyTimeAdvancePlan` — B03-02/03: chronological effects, atomic clock/revision transition и terminal interruption.
8. `projectTaskEvents` / `projectDeadlineEvent` — B03-03: authored task/deadline → strict scheduler events, без state mutation при projection.
9. Functional `lcg32-v1` RNG — B03-03: explicit immutable state + provenance; никакого hidden entropy.
10. Следующий bounded B03-04 закрывает только exact T05/T06/T08 и replay/hash; после него возможен B04.

## Принятые capabilities до B03-03

Gameplay effects: `resource.change`, `item.transfer`.

Conditions: `resource.atLeast`, `entity.at`, `item.heldBy`, `all`, `any`, `not`.

Social acts: `request`, `permission`, `response (accept|refuse)`.

Calculated actions: `core.paint`, `core.social.request`, `core.social.permission`, `core.social.response`.

Scheduler events:

- `core.marker` — strict `ScheduledEvent:1.0`;
- `core.effects` — separate strict `ScheduledEffectEvent:1.0`;
- `core.terminal` — separate strict `ScheduledTerminalEvent:1.0`.

Scheduled task: `core.task` — strict `ScheduledTask:1.0`.

Player/social invariant: request ≠ permission ≠ response ≠ physical execution. Даже `accept` сам не выполняет proposed item/resource mutation.

## Принятые scheduler invariants

- integer absolute elapsed seconds, без `Date`/timezone/wall-clock;
- static planning interval inclusive `[start,end]`;
- deterministic static order `time → order → eventId`;
- past/duplicate/overflow/event-limit — explicit failure;
- event effects проходят только через единый `tryApplyEffectBatch`;
- late event failure отклоняет весь candidate transition без partial state;
- normal success: clock=`plan.end`, revision+1 ровно один раз;
- terminal success: previous effects сохраняются в candidate, terminal фиксируется, clock=terminal timestamp, revision+1, later due events становятся `unprocessedEvents`;
- already terminal authoritative state не запускает новый normal interval;
- task/deadline projection pure и deterministic;
- RNG state/provenance explicit и repeatable.

Generated `capabilities.json` — машинный источник реально опубликованных типов. Planned HTTP operations по-прежнему не являются available.

## Почему общий B03 ещё открыт

Canonical audit после B03-03 выявил четыре конкретных gap, описанных в [B03-04](../tasks/B03-04-b03-matrix-closure.md):

1. typed entity movement и exact T05 (NPC return at 900 inside interval to 2400);
2. exact T06 same timestamp completion-before-deadline + crossing 86_400 integer seconds;
3. dynamic generated child-event processing с sequence/step budget для exact T08;
4. deterministic scheduler replay/state hash для same plan+seed.

Это последний bounded B03 slice. Не заменяй его ранним переходом к B04.

## Что не делать сейчас

Не добавляй persistence, SQLite/Memory adapters, HTTP, idempotency/leases, background loops, wall-clock timers, LLM, Studio/Player или generic plugin manager. Они относятся к следующим блокам.

Следующая карточка: `docs/tasks/B03-04-b03-matrix-closure.md`.

Минимальный цикл: один bounded-шаг → regression реального риска → `npm run verify` → STATUS/HANDOFF/worklog → canonical B03 re-audit.
