# Контекст для агента

Это короткая человеческая точка входа. Сначала прочитай [README](../../README.md), [STATUS](../STATUS.md), [HANDOFF](../HANDOFF.md) и карточку текущей задачи. Полное ТЗ — [docs/SPECIFICATION.md](../SPECIFICATION.md). Машинно собранный текущий контракт находится в [SKILL.md](SKILL.md).

## Текущая лестница причинности

Не смешивай разные обязанности:

1. `ResolvedIntent` — что понял ввод; без duration/effects/state mutation.
2. `Condition` — чистая проверка предпосылки по authoritative `WorldState`.
3. Action/social resolver — что реально возможно и какой смысл имеет explicit действие.
4. `CalculatedAction` — строгий рассчитанный outcome.
5. `tryApplyEffectBatch` — all-or-nothing trial application typed `GameplayEffect`.
6. `planTimeAdvance` — чистый B03-01 planning-layer: какие события попадают в integer interval и в каком порядке.
7. Следующий B03-02 впервые применяет event effects и возвращает новый clock/revision state; persistence всё ещё позже.

## Принятые B02 capabilities

Gameplay effects: `resource.change`, `item.transfer`.

Conditions: `resource.atLeast`, `entity.at`, `item.heldBy`, `all`, `any`, `not`.

Social acts: `request`, `permission`, `response (accept|refuse)`.

Calculated actions: `core.paint`, `core.social.request`, `core.social.permission`, `core.social.response`.

Player/social invariant: request ≠ permission ≠ response ≠ physical execution. Даже `accept` сам не выполняет proposed item/resource mutation.

## Принятый B03-01 scheduler contract

- `ScheduledEvent` v1.0;
- implemented kind: `core.marker`;
- integer absolute `atElapsedSeconds`;
- deterministic `time → order → eventId`;
- inclusive interval `[start,end]`;
- past event = failure, future event = pending;
- duplicate id / unsafe integer / overflow / event-limit = explicit failure;
- planning read-only: clock/revision не коммитятся, effects не применяются.

Generated `capabilities.json` — машинный источник реально опубликованных типов. Planned HTTP operations по-прежнему не являются available.

## Что ещё не реализовано

Event effect application и clock/revision transition — B03-02. NPC task lifecycle, deadlines, interruption/terminal/RNG — B03-03. Runtime API/storage/idempotency — B04. Natural-language/LLM — B06. Studio/Player и Florence migration позже.

Следующая карточка: `docs/tasks/B03-02-event-effects-and-clock-commit.md`. Не добавляй persistence, HTTP, `Date`, wall-clock timers или LLM.

Минимальный цикл: один bounded-шаг → тест реального риска → `npm run verify` → STATUS/HANDOFF/worklog.
