# Передача работы

Обновлено: 2026-09-06

Текущий блок: B01-03 — авторские схемы и минимальный пакет квеста  
Базовый commit: `270c98bd272dbe43879fb023df6e01f647782d35`  
Последний кодовый commit: `08878f9db0598acf0db20a0aa48136f584f4ada1`  
Статус: accepted по bounded-приёмке; публикация выполняется через PR #2

## Выполнено

- Добавлены canonical JSON Schema v1.0 для `Block`, минимального `QuestRelease` и `ResolvedIntent`.
- Текущий Block registry ограничен тремя реально описанными kinds: `core.location`, `core.character`, `core.resource`. Неописанные kinds не принимаются.
- Добавлены TypeScript authoring DTO и публичные exports без изменения Core execution.
- Собран целостный `packages/contracts/fixtures/minimal-quest/`: workshop location, painter character, integer blue-paint resource и release manifest.
- `QuestRelease` semantic validation проверяет уникальность block IDs, точное membership release↔package, entry location, initial character location и resource bounds.
- `ResolvedIntent` хранит только понятое действие (`actionType`, participant/target IDs, args, исходный input). Schema запрещает `durationSeconds`, effects и `statePatch`.
- Добавлены negative fixtures на unknown block kind, несовместимую release version, broken release reference, duplicate block ID и попытку mutation через intent.
- Следующая bounded-карточка B01-04 зафиксирована отдельно; B02 не начинается до полной приёмки общего B01.

## Проверено

GitHub Actions PR run [34022346033](https://github.com/conradipui-glitch/sandboxengine/actions/runs/34022346033), Node `24.19.0`, npm `11.17.0`:

- `npm ci` → успешно;
- `npm run verify` → успешно;
- contract tests → 16/16 passed;
- Core tests → 2/2 passed;
- `check:boundaries` → успешно;
- `docs:check` → успешно.

Отдельно доказано тестами:

- неизвестный block kind и другая release schemaVersion отклоняются JSON Schema;
- broken release ref и duplicate block ID могут быть shape-valid, но отклоняются semantic validation;
- `ResolvedIntent` с duration/statePatch отклоняется;
- invalid resource bounds отклоняются semantic invariant check.

## Не выполнено / ограничения

- B01 целиком ещё не завершён: нет compile skeleton/content hash, endpoint readiness registry, generated OpenAPI/agent-contract pipeline и второго полного fixture-пакета.
- `minimal-quest` пока не исполняется; action resolver и scheduler принадлежат B02/B03.
- Runtime API, storage, LLM, Studio, Player, plugin SDK и Florence migration не начинались.
- T01–T37 не считаются выполненными.
- `npm ci` по-прежнему сообщает 2 dependency vulnerabilities (1 moderate, 1 high); источник не исследован в этом bounded-срезе.

## Следующее действие

После публикации PR #2 выполнить [B01-04 — compile skeleton, readiness registry и generated contracts](tasks/B01-04-compile-registry-docs.md). По завершении B01-04 отдельно сверить полный B01 с общей приёмкой ТЗ и только после этого решать переход к B02.

## Решения

- Block kinds становятся capabilities только после появления точной schema их `data`, а не по одному упоминанию в ТЗ.
- `ResolvedIntent` не является ActionResult и не имеет права менять мир.
- Cross-block references и числовые отношения проверяются deterministic semantic layer поверх JSON Schema.
