# Контекст для агента

Это короткая человеческая точка входа. Сначала прочитай [README](../../README.md), [STATUS](../STATUS.md), [HANDOFF](../HANDOFF.md) и карточку текущей задачи. Полное ТЗ — [docs/SPECIFICATION.md](../SPECIFICATION.md). Машинно собранный текущий контракт находится в [SKILL.md](SKILL.md).

## Текущая лестница причинности

Не смешивай четыре разных слоя:

1. `ResolvedIntent` — что понял ввод. Он не задаёт duration/effects/state mutation.
2. Action resolver — что реально можно выполнить по authoritative `WorldState` и definition.
3. `CalculatedAction` — строгий рассчитанный outcome (`executed/partial/blocked`, completion, reason, duration, gameplay effects).
4. `tryApplyEffectBatch` — all-or-nothing trial application typed `GameplayEffect` к копии state.

Сейчас зарегистрировано:

- gameplay effect `resource.change`;
- calculated action `core.paint`.

`core.paint` получает `args.units` из уже resolved explicit intent. Определение задаёт расход ресурса на единицу, duration/unit и partial policy. Resolver сам считает completed units и не доверяет клиенту/модели duration или delta.

## Контрактные границы

B01 generic `Effect` v1.0 и public `ActionResult` v1.0 не переписаны. B02 использует отдельные strict `GameplayEffect` и `CalculatedAction`; см. ADR 0003 и 0004. Не расширяй старые strict schemas с тем же ID молча.

Duration в `CalculatedAction` — только вычисленное число. `WorldState.clock` и `revision` пока не продвигаются; scheduler/commit начинаются позже. `blocked` в текущем `core.paint` означает no effects и duration 0.

Generated `capabilities.json` является машинным списком реально реализованного: сейчас block kinds, `resource.change`, `core.paint`; HTTP operations отсутствуют. `npm run docs:generate`/`docs:check` обязательны при изменении схем/capabilities.

## Что ещё не реализовано

Нет общего языка conditions/preconditions, item/entity effects, social request/consent actions, `conditional`, scheduler, Runtime API, storage, LLM и Studio. Следующая карточка B02-03 расширяет общие механики, а не добавляет Florence-specific ветки.

Минимальный цикл: один bounded-шаг → тест реального риска → `npm run verify` → STATUS/HANDOFF/worklog. Core остаётся без HTTP/storage/LLM.
