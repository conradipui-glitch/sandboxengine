# Передача работы

Обновлено: 2026-09-06

Текущий блок: B02-02 — explicit action resolver  
Базовый commit: `82d554f1933087e95a08d97c2fa6625d3a5c93b3`  
Последний кодовый commit: `9be90f57a1bcf0085095fc057e39244cc0a16c5c`  
Статус: accepted по bounded-приёмке; публикация выполняется через PR #5

## Выполнено

- Добавлен strict `CalculatedAction` v1.0 как отдельный gameplay outcome contract; B01 `ActionResult` v1.0 не изменён.
- Первый calculated action type — `core.paint`.
- `resolvePaintAction(state, definition, intent)` принимает уже resolved explicit intent и authoritative state; natural language здесь не интерпретируется.
- Определение `core.paint` задаёт resource ID, расход на completed unit, duration/unit и allowPartial.
- Достаточный ресурс → `executed`; ограниченный ресурс при allowPartial → `partial` + `RESOURCE_LIMIT`; отсутствие доступного ресурса или запрет partial → `blocked` с 0 sec/effects[].
- Рассчитанный effect перед success обязательно проходит B02-01 `tryApplyEffectBatch`.
- Duration рассчитывается, но clock/revision не изменяются.
- Invalid intent/definition не возвращают calculated state.
- Generated capabilities/SKILL теперь содержат `core.paint`; HTTP operations всё ещё 0 available.
- Разделение `CalculatedAction`/public `ActionResult` зафиксировано ADR 0004.

## Проверено

GitHub Actions PR run [34024417932](https://github.com/conradipui-glitch/sandboxengine/actions/runs/34024417932), Node `24.19.0`, npm `11.17.0`:

- `npm ci` → успешно;
- `npm run verify` → успешно;
- contract tests → 22/22 passed;
- Core tests → 15/15 passed;
- `check:boundaries` → успешно;
- `docs:check` → успешно.

Опорный T01 Core:

- state: `blue_paint=2`, min=0;
- definition: cost=1, duration=300 sec/unit, allowPartial=true;
- explicit intent: `core.paint`, units=8;
- результат: `partial`, requested=8, completed=2, reason=`RESOURCE_LIMIT`, duration=600, `resource.change delta=-2`, trial next state paint=0;
- повтор на paint=0 → `blocked`, duration=0, effects=[], state не изменён.

Также проверены executed при достаточном ресурсе, partial-disabled blocking и rejection invalid intent/definition.

## Не выполнено / ограничения

- Нет общего condition/precondition языка; resolver `core.paint` пока использует свою типизированную арифметику ресурса.
- Из gameplay effects реализован только `resource.change`; item/entity/variable effects отсутствуют.
- `conditional` ещё не рассчитывается; социальные просьбы/согласия T02–04 не реализованы.
- Clock/revision/storage commit отсутствуют; duration пока только число расчёта.
- Public `ActionResult` v1.0 не несёт `CalculatedAction`; API migration будет отдельным решением B04.
- Свободный текст/LLM/HTTP/Studio/Florence не затрагивались.
- `npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high); force-upgrade не выполнялся.

## Следующее действие

После публикации PR #5 выполнить [B02-03 — declarative conditions и item transfer](tasks/B02-03-conditions-item-transfer.md): добавить минимальный общий condition evaluator и `item.transfer` в `GameplayEffect`, доказать ownership/reference invariants и atomic batch T07 без scheduler/LLM.

## Решения

- См. ADR 0003: executable `GameplayEffect` отдельно от generic Effect v1.0.
- См. ADR 0004: gameplay `CalculatedAction` отдельно от public transport ActionResult v1.0.
- `ResolvedIntent` сообщает намерение; resolver сам вычисляет completion/duration/effects по state. Модель или клиент не передают эти значения как авторитетные.
