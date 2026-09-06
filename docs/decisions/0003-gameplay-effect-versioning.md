# ADR 0003 — отдельный GameplayEffect вместо тихого расширения Effect v1.0

Статус: принято 2026-09-06.

## Контекст

B01 опубликовал строгую JSON Schema `Effect` v1.0 с полями `schemaVersion`, `type`, `sourceId` и `additionalProperties: false`. B02 впервые требует исполняемый `resource.change` с `resourceId` и `delta`.

Просто добавить payload-поля в существующую schema означало бы несовместимо изменить уже опубликованный контракт с тем же `$id`/версией. Оставить `Effect` произвольным словарём означало бы потерять строгую проверку исполняемых изменений мира.

## Решение

- `Effect` v1.0 остаётся неизменным generic envelope B01.
- Исполняемые изменения мира получают отдельную каноническую schema `GameplayEffect` v1.0 и отдельный TypeScript discriminated union.
- Первый зарегистрированный тип — `resource.change` с `resourceId`, целочисленной `delta` и `sourceId` provenance.
- `tryApplyEffectBatch` принимает только `GameplayEffect`; generic `Effect` не становится исполняемым только потому, что его `type` совпал строкой.
- Новые gameplay effect types добавляются только вместе со строгой schema/guard/tests и обновлением generated capabilities.
- Если будущий публичный `ActionResult` должен нести typed gameplay effects вместо generic `Effect`, это оформляется отдельным compatibility/versioning изменением, а не молчаливой правкой v1.0.

## Следствия

Плюс: B01 consumer не ломается, а Core получает строгую исполняемую границу. Минус: временно существуют два понятия — generic `Effect` и executable `GameplayEffect`; документация обязана явно их различать до следующего согласованного контрактного перехода.
