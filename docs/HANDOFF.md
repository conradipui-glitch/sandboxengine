# Передача работы

Обновлено: 2026-09-06

Текущий блок: B02-03 — declarative conditions и item transfer  
Базовый commit: `b675fbd7e2e9ad8f583d20faeeed2b1ccbb3b9ed`  
Последний кодовый commit: `5c06e182614869d2f360389a0e5471facc236162`  
Статус: accepted по bounded-приёмке; публикация выполняется через PR #6

## Выполнено

- Добавлен strict `Condition` v1.0: `resource.atLeast`, `entity.at`, `item.heldBy`, `all`, `any`, `not`.
- `evaluateCondition` работает только по authoritative `WorldState`, не меняет state и не использует `eval`/произвольные expressions.
- Нормальный `false` отделён от invalid condition и broken reference. Несуществующий resource/entity/location/item/holder возвращает failure.
- `all`/`any` не скрывают broken reference short-circuit'ом: все дети проверяются на целостность.
- `GameplayEffect` расширен вторым реально исполняемым типом `item.transfer`.
- Destination предмета — ровно одна позиция: `location` или `holder`; item/destination refs проверяются перед применением.
- `tryApplyEffectBatch` теперь trial-применяет и resources, и items. При любой ошибке batch новый state не возвращается.
- Valid item transfer создаёт immutable next state, исходный state не мутируется.
- Generated capabilities/SKILL публикуют conditions и оба effect type; HTTP operations всё ещё 0 available.
- Решение зафиксировано ADR 0005.

## Проверено

GitHub Actions PR run [34028543840](https://github.com/conradipui-glitch/sandboxengine/actions/runs/34028543840), Node `24.19.0`, npm `11.17.0`:

- `npm ci` → успешно;
- `npm run verify` → успешно после точечного TypeScript narrowing fix;
- contract tests → 24/24 passed;
- Core tests → 21/21 passed;
- `check:boundaries` → успешно;
- `docs:check` → успешно.

Опорный T07 Core:

1. authoritative state: `blue_paint=2`, `sealed-box` находится в `workshop`;
2. effect #0: `resource.change blue_paint -1` — валиден;
3. effect #1: `item.transfer sealed-box → holder missing-holder` — ссылка не существует;
4. итог: `holder_not_found`, `effectIndex=1`, новый state отсутствует;
5. исходный `blue_paint` остаётся 2, `sealed-box` остаётся в исходной position.

Также проверено:

- valid transfer `sealed-box → painter` создаёт новую единственную holder-position без mutation input;
- `resource.atLeast` даёт true/false на известных IDs;
- `entity.at` и `item.heldBy` дают deterministic boolean на известных IDs;
- broken ref возвращает failure даже если предыдущий child в `all` уже дал false;
- unknown condition/effect types и unknown fields отклоняются strict contract.

## Не выполнено / ограничения

- Conditions пока не подключены к общему registry action definitions; B02-03 доказывает evaluator и contracts как отдельный reusable слой.
- Social request/permission/acceptance и status `conditional` ещё не имеют отдельной semantics — это B02-04.
- Из effects пока только `resource.change` и `item.transfer`; entity/variable/task/event effects не объявлены доступными.
- Clock/revision/storage commit отсутствуют; scheduler — B03.
- Свободный текст/LLM/HTTP/Studio/Florence не затрагивались.
- `npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high); force-upgrade не выполнялся.

## Следующее действие

После публикации PR #6 выполнить [B02-04 — social/player-agency semantics](tasks/B02-04-social-agency.md): на explicit actions разделить просьбу, разрешение и фактическое согласие/исполнение, зафиксировать `conditional` как ожидание решения другого участника и доказать T02–04 без LLM, scheduler или runtime storage.

## Решения

- См. ADR 0003: executable `GameplayEffect` отдельно от generic Effect v1.0.
- См. ADR 0004: gameplay `CalculatedAction` отдельно от public transport ActionResult v1.0.
- См. ADR 0005: declarative Condition отделяет false от broken definition; mixed effect batch атомарен.
- Модель/клиент не получают права превращать request/permission в agreement — следующий bounded-срез закрепляет это в explicit social contracts.
