# Контекст для агента

Это короткая человеческая точка входа. Сначала прочитай [README](../../README.md), [STATUS](../STATUS.md), [HANDOFF](../HANDOFF.md) и карточку текущей задачи. Полное ТЗ — [docs/SPECIFICATION.md](../SPECIFICATION.md). Машинно собранный текущий контракт находится в [SKILL.md](SKILL.md).

## Текущая лестница причинности

Не смешивай пять разных обязанностей:

1. `ResolvedIntent` — что понял ввод. Он не задаёт duration/effects/state mutation.
2. `Condition` / `evaluateCondition` — можно ли считать предпосылку выполненной по authoritative `WorldState`; проверка не меняет state.
3. Action resolver — что реально можно выполнить по authoritative state и definition.
4. `CalculatedAction` — строгий рассчитанный outcome (`executed/partial/blocked`, completion, reason, duration, gameplay effects).
5. `tryApplyEffectBatch` — all-or-nothing trial application typed `GameplayEffect` к копии state.

Сейчас зарегистрировано:

- gameplay effects: `resource.change`, `item.transfer`;
- conditions: `resource.atLeast`, `entity.at`, `item.heldBy`, `all`, `any`, `not`;
- calculated action: `core.paint`.

`core.paint` получает `args.units` из уже resolved explicit intent. Определение задаёт расход ресурса на единицу, duration/unit и partial policy. Resolver сам считает completed units и не доверяет клиенту/модели duration или delta.

`item.transfer` переносит уникальный item ровно в одну position: `location` или `holder`. Если любой effect в mixed batch не проходит проверку, новый state не возвращается и предыдущие trial-изменения не считаются применёнными.

## Condition semantics

Корректное условие может дать `true` или `false`. Broken reference — отдельная ошибка определения, а не `false`. Например, `resource.atLeast` для отсутствующего ресурса возвращает failure. `all`/`any` в текущем Core намеренно проверяют все дочерние условия на целостность и не скрывают broken reference short-circuit'ом.

Condition — только данные и чистая проверка. В нём нет JavaScript expressions, `eval`, effects или mutation.

## Контрактные границы

B01 generic `Effect` v1.0 и public `ActionResult` v1.0 не переписаны. B02 использует отдельные strict `GameplayEffect`, `Condition` и `CalculatedAction`; см. ADR 0003–0005. Не расширяй старые strict schemas с тем же ID молча.

Duration в `CalculatedAction` — только вычисленное число. `WorldState.clock` и `revision` пока не продвигаются; scheduler/commit начинаются позже.

Generated `capabilities.json` является машинным списком реально реализованного. HTTP operations по-прежнему отсутствуют. `npm run docs:generate`/`docs:check` обязательны при изменении схем/capabilities.

## Что ещё не реализовано

Нет social request/permission/acceptance semantics, общего action-definition registry поверх Condition, entity/variable/task/event effects, scheduler, Runtime API, storage, LLM и Studio. Следующая карточка B02-04 закрепляет player-agency на explicit social actions: просьба, разрешение и согласие другого участника не должны превращаться друг в друга автоматически.

Минимальный цикл: один bounded-шаг → тест реального риска → `npm run verify` → STATUS/HANDOFF/worklog. Core остаётся без HTTP/storage/LLM.
