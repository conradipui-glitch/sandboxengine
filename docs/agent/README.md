# Контекст для агента

Это короткая человеческая точка входа. Сначала прочитай [README](../../README.md), [STATUS](../STATUS.md), [HANDOFF](../HANDOFF.md) и карточку текущей задачи. Полное ТЗ — [docs/SPECIFICATION.md](../SPECIFICATION.md). Машинно собранный текущий контракт находится в [SKILL.md](SKILL.md).

## Текущая лестница причинности

Не смешивай разные обязанности:

1. `ResolvedIntent` — что понял ввод; без duration/effects/state mutation.
2. `Condition` — чистая проверка предпосылки по authoritative `WorldState`.
3. Action/social resolver — что реально возможно и какой смысл имеет explicit действие.
4. `CalculatedAction` — строгий рассчитанный outcome.
5. `tryApplyEffectBatch` — all-or-nothing trial application typed `GameplayEffect`.
6. B03 добавляет игровое время/scheduler поверх уже рассчитанной duration; B02 сам clock не двигает.

## Принятые B02 capabilities

Gameplay effects:

- `resource.change`;
- `item.transfer`.

Conditions:

- `resource.atLeast`;
- `entity.at`;
- `item.heldBy`;
- `all`;
- `any`;
- `not`.

Social acts:

- `request`;
- `permission`;
- `response` (`accept|refuse`).

Calculated actions:

- `core.paint`;
- `core.social.request`;
- `core.social.permission`;
- `core.social.response`.

Generated `capabilities.json` — машинный источник реально опубликованных типов. Planned HTTP operations по-прежнему не являются available.

## Player/social agency — обязательный Core-инвариант

`request`, `permission` и `response` нельзя преобразовывать друг в друга.

- Request → `conditional / AWAITING_RESPONSE`, effects=[].
- Permission → `executed` только как состоявшееся разрешение; permitted physical action не считается выполненным.
- Response обязан ссылаться на конкретный known request и его адресата.
- `accept`/`refuse` фиксируют решение, но даже `accept` не выполняет proposed physical action.

Если proposed action должен передать item, потратить ресурс или иначе изменить world state, он проходит отдельный resolver/effect pipeline. Это правило нельзя обходить LLM, клиентом или будущим plugin.

Регрессии B02: T01, T02, T03, T04, T07. Общий B02 принят.

## Condition/effect invariants

Known condition может дать true/false; broken reference — failure, не false. Composite conditions проверяют целостность всех children.

`tryApplyEffectBatch` возвращает либо полный trial next state, либо failure без state. Mixed resource/item batch не имеет partial commit.

## Что ещё не реализовано

Clock/revision commit, event queue, tasks, deadlines, interruptions, terminal/RNG — B03. Runtime API/storage/idempotency — B04. Natural-language/LLM — B06. Studio/Player и Florence migration позже.

Следующая карточка: `docs/tasks/B03-01-clock-event-queue.md`. Начинай с чистого integer-time plan; не добавляй HTTP, storage, `Date`, wall-clock timers или LLM.

Минимальный цикл: один bounded-шаг → тест реального риска → `npm run verify` → STATUS/HANDOFF/worklog.
