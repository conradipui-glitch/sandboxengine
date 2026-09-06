# B02-03 — declarative conditions и item transfer

## Цель

После первого resolver убрать следующую конкретную зависимость от `core.paint`: дать Core минимальный общий evaluator preconditions и второй базовый gameplay effect для уникальных предметов. Срез должен доказать T07 — расход ресурса и передача предмета применяются одним атомарным batch либо не применяются вообще.

## Вход

- B02-01 `GameplayEffect` / `tryApplyEffectBatch`;
- B02-02 `CalculatedAction` / resolver boundary;
- `WorldState.entities/resources/items`;
- §7.3 и T07 `docs/SPECIFICATION.md`.

## Сделать

1. Добавить strict `Condition` contract с минимальными операциями первого среза:
   - `resource.atLeast(resourceId, value)`;
   - `entity.at(entityId, locationId)`;
   - `item.heldBy(itemId, holderId)`;
   - композиция `all`, `any`, `not` с ограниченной структурой без eval/JS expressions.
2. Чистый evaluator различает `false` condition и invalid condition/reference. Неизвестный ID не превращается автоматически в `false`, если это ошибка определения.
3. Расширить `GameplayEffect` зарегистрированным `item.transfer`: item ID + destination (`location` или `holder`) + provenance.
4. `tryApplyEffectBatch` должен trial-применять и resources, и items. Передача проверяет существование item/holder/location и не допускает двух независимых позиций одного предмета.
5. Доказать атомарность смешанного batch: валидный `resource.change`, затем невалидный `item.transfer` → failure без нового state и без списания ресурса.
6. Валидный transfer должен создать новый state, где предмет имеет ровно одну новую position, а исходный state не мутирован.
7. Добавить schema/fixtures/parity tests и обновить generated capabilities для реально доступного `item.transfer` и Condition schema.
8. Не добавлять произвольные переменные/effects только ради полноты списка; остальные базовые эффекты идут следующими bounded-срезами.

## Приёмка

- `npm run verify` на clean runner;
- resource/entity/item conditions дают deterministic true/false на известных IDs;
- broken reference condition возвращает validation/evaluation failure, а не тихое false;
- valid item transfer соблюдает holder/location references и immutable input;
- mixed batch с ошибкой второго effect не возвращает state и не применяет первый resource change;
- generated capabilities перечисляют только реально реализованные effect types;
- Core без HTTP/storage/LLM/scheduler.

## Не делать

Свободный текст, social consent, task scheduling, clock advance, full variable system, event effects, HTTP, SQLite, Studio или Florence-specific rules.

## Следом

B02-04 должен закрыть player-agency/social semantics T02–04 на explicit actions: просьба/разрешение/согласие и `conditional` не смешиваются, не требуя LLM или scheduler.
