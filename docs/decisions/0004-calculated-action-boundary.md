# ADR 0004 — CalculatedAction отделён от публичного ActionResult v1.0

Статус: принято 2026-09-06.

## Контекст

B01 зафиксировал строгий публичный `ActionResult` v1.0 до появления реального resolver. B02-02 впервые требует выразить рассчитанный gameplay outcome: конкретный action type, фактически выполненный объём, reason code, duration и strict `GameplayEffect` batch.

Тихо заменить `ActionResult.effects` или добавить эти поля к существующему strict schema с тем же `$id` означало бы несовместимо переписать опубликованный контракт.

## Решение

- B01 `ActionResult` v1.0 остаётся неизменным transport boundary до отдельной миграции API.
- Вводится отдельный strict `CalculatedAction` v1.0 как внутренний/межмодульный результат gameplay calculation.
- `CalculatedAction` — discriminated union по `actionType`; первый вариант — `core.paint`.
- Resolver возвращает `CalculatedAction` и trial next state отдельно. `CalculatedAction` не содержит `statePatch`/произвольный mutable state.
- Duration в нём является рассчитанной длительностью, а не фактом продвижения игрового clock.
- Когда Runtime API будет проектироваться в B04, публичный result contract либо получит новую совместимую версию/обёртку над `CalculatedAction`, либо сохранит адаптацию явно. B02 не переписывает transport задним числом.

## Следствия

Core уже может проверяемо считать `executed/partial/blocked`, не ломая B01 consumers. Временно существуют transport `ActionResult` и gameplay `CalculatedAction`; документация и типы должны различать их до явной API-миграции.
