# Контекст для агента

Это короткая человеческая точка входа. Сначала прочитай [README](../../README.md), [STATUS](../STATUS.md), [HANDOFF](../HANDOFF.md) и карточку текущей задачи. Полное ТЗ — [docs/SPECIFICATION.md](../SPECIFICATION.md). Машинно собранный текущий контракт находится в [SKILL.md](SKILL.md).

## Текущий контрактный слой

Канонический источник формата DTO — JSON Schema Draft 2020-12 в [`packages/contracts/schemas/v1/`](../../packages/contracts/schemas/v1/). Текущая версия схем — `1.0`. Не придумывай обязательные поля по ТЗ, если их ещё нет в фактической схеме.

Сейчас опубликованы схемы/TypeScript-экспорты для `Effect`, `ActionResult`, минимального `WorldState`, `SceneFrame`, `PresentationPlan`, `Block`, минимального `QuestRelease` и `ResolvedIntent`. Текущие block kinds: `core.location`, `core.character`, `core.resource`.

`ResolvedIntent` — только результат понимания ввода: у него нет права возвращать duration/effects/state mutation. `compileQuest` также не исполняет игру: он проверяет contract version и semantic references, нормализует уже schema-valid package и строит immutable artifact + canonical SHA-256 content hash.

## Generated contracts

`npm run docs:generate` детерминированно собирает:

- `SKILL.md` — короткий agent contract;
- `schema-index.json` — индекс канонических схем;
- `capabilities.json` — только реально доступные block kinds и HTTP operations;
- `api.openapi.json` — только реализованные HTTP operations;
- `compatibility.json` — версии и registry hash.

`packages/contracts/registry/endpoints.json` может содержать planned endpoints, но генератор исключает их из списка доступных. На текущем B01 Runtime/Control API ещё не существует, поэтому generated OpenAPI имеет пустой `paths`. Не превращай planned запись в рабочую capability без реализации и readiness change в том же проверяемом change set.

JSON Schema проверяет форму; существование ID и целостность package проверяются отдельными детерминированными функциями. `docs:check` дополнительно проверяет, что generated agent contracts не устарели.

## Текущая граница

B01 принят как контрактный/compile каркас. Action resolver, gameplay effects и mutation WorldState начинаются с B02; scheduler — B03; HTTP/storage — B04. Наличие схемы или planned endpoint не является доказательством работающей механики.

Минимальный рабочий цикл: делай один bounded-шаг; Core импортирует только публичный `@living-history/contracts`; модель не изменяет state напрямую; запускай `npm run verify`; сохраняй незавершённость и следующий шаг в handoff.
