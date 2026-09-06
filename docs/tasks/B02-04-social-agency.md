# B02-04 — social/player-agency semantics

## Цель

Закрыть explicit Core-семантику T02–T04 до подключения LLM: просьба одного участника, разрешение/не-запрет и решение другого участника должны быть разными проверяемыми понятиями. Ни просьба, ни разрешение сами по себе не являются согласием адресата и не исполняют физическое действие.

## Вход

- B02-02 boundary `ResolvedIntent → resolver → CalculatedAction`;
- B02-03 `Condition` и атомарные `GameplayEffect`;
- обязательный принцип player agency из `docs/SPECIFICATION.md`;
- регрессионные случаи Florence: «оставить мне копию», «не запрещаю передать мой ответ», просьба/предложение не равны согласию другого персонажа.

## Сделать

1. Ввести strict versioned social contract, который структурно различает минимум:
   - `request` — один участник просит другого выполнить предложенное действие;
   - `permission` — один участник разрешает/не запрещает действие другого;
   - `response` — адресат явно принимает или отклоняет конкретную просьбу/предложение.
2. Социальный proposal должен хранить стабильный ID, участников и структурированное proposed intent/subject, но не duration, gameplay effects или state patch.
3. Core должен валидировать участников по `WorldState.entities`. Broken entity/reference — definition/resolution failure, а не социальный отказ.
4. `request` не создаёт эффект предложенного действия и не означает acceptance. Рассчитанный outcome должен сохранять состояние ожидания/`conditional` там, где требуется решение адресата.
5. `permission` не создаёт request от имени игрока, не создаёт agreement и не исполняет разрешённое действие. Формулировка «не запрещаю X» должна оставаться permission, а не преобразовываться в «прошу сделать X».
6. `response: accept` и `response: refuse` должны ссылаться на конкретный proposal/request ID и оставаться различимыми результатами. Ответ не может существовать как безымянное «согласие вообще».
7. Даже explicit acceptance в этом bounded-срезе не должно обходить обычный resolver/effect pipeline для физического действия. Если фактическое выполнение требует item/resource/state mutation, оно остаётся отдельным рассчитанным действием следующего слоя, а не скрытым side effect social response.
8. Доказать регрессиями T02–T04:
   - просьба «оставить мне копию» не превращается в обратный `item.transfer` оригинала от игрока/мастерской адресату;
   - permission «не запрещаю передать мой ответ» не превращается в новую просьбу перенести показ/изменить условия;
   - отправленная просьба остаётся pending/conditional до explicit response; refusal не может быть представлен как acceptance.
9. Обновить canonical schema, TypeScript parity tests и generated capabilities только для реально реализованных social types.
10. Не подключать natural-language classification: тесты используют explicit structured social input, чтобы сначала закрепить Core-смысл.

## Приёмка

- `npm run verify` на clean runner;
- request / permission / response имеют разные strict discriminants;
- request и permission не возвращают gameplay effects физического proposed action;
- request, которому нужен ответ другого персонажа, не выдаётся за `executed` agreement;
- response обязан ссылаться на конкретный известный proposal/request; broken reference — failure;
- accept и refuse различаются детерминированно;
- T02–T04 regression tests проходят;
- Core остаётся без LLM, HTTP, storage и scheduler.

## Не делать

Natural-language parser, память диалогов в БД, NPC decision AI, отношения/репутацию, scheduler, автоматическое исполнение accepted action, HTTP, Studio или Florence-specific prompt rules.

## Следом

После B02-04 отдельно сверить общую приёмку B02. Если Core-матрица B02 закрыта, переходить к B03 — игровое время, tasks, scheduler/deadlines и хронологическое выполнение событий внутри длительного действия. Если общей приёмке B02 не хватает базового effect/condition/action primitive, создать один bounded B02-05 вместо преждевременного перехода к B03.
