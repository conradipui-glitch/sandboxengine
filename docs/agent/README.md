# Контекст для агента

Это короткая точка входа, а не полный Skill. Сначала прочитай [README](../../README.md), [STATUS](../STATUS.md), [HANDOFF](../HANDOFF.md) и карточку текущей задачи. Полное ТЗ — [docs/SPECIFICATION.md](../SPECIFICATION.md).

## Текущий контрактный слой

Канонический источник формата DTO — JSON Schema Draft 2020-12 в [`packages/contracts/schemas/v1/`](../../packages/contracts/schemas/v1/). Текущая версия схем — `1.0`. Не придумывай обязательные поля по ТЗ, если их ещё нет в фактической схеме.

Сейчас опубликованы схемы/TypeScript-экспорты для:

- `Effect`;
- `ActionResult` / совместимого имени `ActionResultEnvelope`;
- минимального `WorldState`;
- `SceneFrame`;
- `PresentationPlan`;
- `Block` с текущими kinds `core.location`, `core.character`, `core.resource`;
- минимального `QuestRelease`;
- `ResolvedIntent`.

`@living-history/contracts` также экспортирует статусы, `CONTRACT_SCHEMA_VERSION`, `CONTRACT_SCHEMA_IDS` и semantic reference checks. JSON Schema проверяет форму; существование ID и целостность package проверяются отдельными детерминированными функциями. Не выдавай одну проверку за другую.

`ResolvedIntent` — только результат понимания ввода. В нём нет `durationSeconds`, effects или `statePatch`; время и изменения мира будут рассчитываться Core в следующих блоках. Текущий `QuestRelease` — минимальный reference manifest: content hash/plugin lock ещё не считаются готовыми до compile slice.

Текущий `PresentationPlan` фиксирует только `sequence`, `parallel`, `actor.show`, `item.show`, `dialogue.show`. Другие команды из полного ТЗ пока planned. Аналогично, остальные типы Block из ТЗ не считаются доступными, пока не получат каноническую schema.

На текущем этапе публичных HTTP endpoint, runtime-хранилища, LLM-провайдера, Studio и готового полного `SKILL.md` ещё нет. Нельзя выдумывать их по этому файлу.

Минимальный рабочий цикл: делай один bounded-шаг; Core импортирует только публичный `@living-history/contracts`; модель не изменяет state напрямую; запускай `npm run verify`; сохраняй незавершённость и следующий шаг в handoff.
