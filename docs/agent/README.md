# Контекст для агента

Это короткая точка входа, а не полный Skill. Сначала прочитай [README](../../README.md), [STATUS](../STATUS.md), [HANDOFF](../HANDOFF.md) и карточку текущей задачи. Полное ТЗ — [docs/SPECIFICATION.md](../SPECIFICATION.md).

## Текущий контрактный слой

Канонический источник формата DTO первого слоя — JSON Schema Draft 2020-12 в [`packages/contracts/schemas/v1/`](../../packages/contracts/schemas/v1/). Текущая версия этих схем — `1.0`. Не придумывай обязательные поля по ТЗ, если их ещё нет в фактической схеме.

Сейчас опубликованы схемы и TypeScript-экспорты для:

- `Effect`;
- `ActionResult` / совместимого имени `ActionResultEnvelope`;
- минимального `WorldState`;
- `SceneFrame`;
- `PresentationPlan`.

`@living-history/contracts` также экспортирует `ActionStatus`, `ProcessingStatus`, `CONTRACT_SCHEMA_VERSION`, `CONTRACT_SCHEMA_IDS` и проверки ссылок первого слоя. `ActionResult` дополнительно имеет runtime guard; контрактные тесты сверяют его с JSON Schema на общих fixtures.

Правила v1.0: неизвестные поля отклоняются; другая `schemaVersion` несовместима; ссылки хранят устойчивые ID. JSON Schema проверяет форму, а существование ссылок между объектами проверяется отдельной семантикой (`hasValidWorldStateReferences`, `hasValidPresentationPlanReferences`). Не выдавай одну проверку за другую.

Текущий `PresentationPlan` фиксирует только те команды, чьи аргументы уже закреплены проверяемым примером: `sequence`, `parallel`, `actor.show`, `item.show`, `dialogue.show`. Другие команды, перечисленные в полном ТЗ, пока не являются реализованным контрактом. Минимальный `WorldState` также ещё не содержит будущие tasks/events/knowledge/extensions.

На текущем этапе публичных HTTP endpoint, runtime-хранилища, LLM-провайдера, Studio и готового `SKILL.md` ещё нет. Нельзя выдумывать их по этому файлу.

Минимальный рабочий цикл: делай один bounded-шаг; Core импортирует только публичный `@living-history/contracts`; модель не изменяет state напрямую; запускай `npm run verify`; сохраняй незавершённость и следующий шаг в handoff.
