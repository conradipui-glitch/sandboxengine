# Контекст для агента

Это короткая человеческая точка входа. Сначала прочитай [README](../../README.md), [STATUS](../STATUS.md), [HANDOFF](../HANDOFF.md) и карточку текущей задачи. Полное ТЗ — [docs/SPECIFICATION.md](../SPECIFICATION.md). Машинно собранный текущий контракт находится в [SKILL.md](SKILL.md).

## Текущая лестница причинности

Не смешивай разные обязанности:

1. `ResolvedIntent` — что понял ввод; без duration/effects/state mutation.
2. `Condition` — чистая проверка предпосылки по authoritative `WorldState`.
3. Action/social resolver — что реально возможно и какой смысл имеет explicit действие.
4. `CalculatedAction` — строгий рассчитанный outcome.
5. `tryApplyEffectBatch` — all-or-nothing typed world mutation на trial state.
6. `planTimeAdvance` — B03-01: какие scheduler events попадают в integer interval и в каком deterministic order.
7. `applyTimeAdvancePlan` — B03-02: применяет due effects по plan и коммитит новый clock/revision одним Core transition.
8. B03-03 добавляет task/deadline/terminal interruption и deterministic RNG поверх этих уже принятых границ.

## Принятые B02 capabilities

Gameplay effects: `resource.change`, `item.transfer`.

Conditions: `resource.atLeast`, `entity.at`, `item.heldBy`, `all`, `any`, `not`.

Social acts: `request`, `permission`, `response (accept|refuse)`.

Calculated actions: `core.paint`, `core.social.request`, `core.social.permission`, `core.social.response`.

Player/social invariant: request ≠ permission ≠ response ≠ physical execution. Даже `accept` сам не выполняет proposed item/resource mutation.

## Принятый B03 scheduler слой

### B03-01

- strict marker-only `ScheduledEvent:1.0`, kind `core.marker`;
- integer absolute time;
- inclusive `[start,end]`;
- deterministic `time → order → eventId`;
- past/duplicate/overflow/event-limit failures;
- planning read-only.

### B03-02

- опубликованный `ScheduledEvent:1.0` не расширялся;
- отдельный strict `ScheduledEffectEvent:1.0`, kind `core.effects`;
- Core union `SchedulerEvent`;
- due effects применяются только через B02 `tryApplyEffectBatch`;
- поздний event failure отклоняет весь interval без partial state;
- success: clock=`plan.end`, revision+1 ровно один раз;
- zero-duration committed transition сохраняет clock и увеличивает revision один раз;
- pending events не применяются преждевременно.

Generated `capabilities.json` — машинный источник реально опубликованных типов. Planned HTTP operations по-прежнему не являются available.

## Что ещё не реализовано

Task definitions/lifecycle, deadline → terminal event, interruption длинного interval, deterministic RNG/provenance — B03-03. Runtime API/storage/idempotency — B04. Natural-language/LLM — B06. Studio/Player и Florence migration позже.

Следующая карточка: `docs/tasks/B03-03-tasks-deadlines-interruptions-rng.md`. Не добавляй persistence, HTTP, `Date`, wall-clock timers, background loops или LLM.

Минимальный цикл: один bounded-шаг → тест реального риска → `npm run verify` → STATUS/HANDOFF/worklog.
