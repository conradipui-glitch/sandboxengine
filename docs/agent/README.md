# Контекст для агента

Это короткая человеческая точка входа. Сначала прочитай [README](../../README.md), [STATUS](../STATUS.md), [HANDOFF](../HANDOFF.md) и карточку текущей задачи. Полное ТЗ — [docs/SPECIFICATION.md](../SPECIFICATION.md). Машинно собранный текущий контракт находится в [SKILL.md](SKILL.md).

## Текущий контрактный слой

Канонический источник DTO — JSON Schema Draft 2020-12 в [`packages/contracts/schemas/v1/`](../../packages/contracts/schemas/v1/). Текущая schema family version — `1.0`.

B01 generic `Effect` v1.0 — только envelope `schemaVersion/type/sourceId`; он **не является автоматически исполняемым изменением мира**. С B02-01 добавлен отдельный strict `GameplayEffect` v1.0. Сейчас зарегистрирован один executable type:

- `resource.change` — `resourceId`, целочисленная `delta`, provenance `sourceId`.

Причина разделения записана в [ADR 0003](../decisions/0003-gameplay-effect-versioning.md): нельзя тихо расширять strict `Effect` v1.0 новыми обязательными/payload полями с тем же schema ID.

## Что Core реально умеет сейчас

- `compileQuest` проверяет/нормализует schema-valid package и строит immutable artifact + SHA-256; он не исполняет действия.
- `tryApplyEffectBatch` принимает уже рассчитанный batch `GameplayEffect`, проверяет его на копии `WorldState` и возвращает либо полный новый state, либо failure без state.
- `resource.change` соблюдает существование resource, integer/safe-integer и min/max.
- Исходный state, revision и clock не изменяются этим trial-layer.

Core **ещё не** умеет по `ResolvedIntent` выбирать action definition, проверять action preconditions, вычислять duration/partial/blocked или делать игровой commit. Это следующий B02-02.

## Generated contracts

`npm run docs:generate` собирает `SKILL.md`, schema index, capabilities, OpenAPI и compatibility. `capabilities.json` теперь показывает `resource.change`, потому что он реально реализован. Planned HTTP endpoints по-прежнему не попадают в available operations; OpenAPI `paths` пуст.

`docs:check` должен проходить после любого изменения схем/registry/capabilities. Не редактируй generated files вручную как источник истины.

Минимальный рабочий цикл: один bounded-шаг; Core без HTTP/storage/LLM; модель не меняет state напрямую; `npm run verify`; затем STATUS/HANDOFF/worklog.
