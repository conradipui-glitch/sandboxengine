# Передача работы

Обновлено: 2026-09-06

Текущий блок: B01-02 — канонические схемы первого слоя  
Базовый commit: `3b77e644925bd2b2821139f8dca6bec97c0a1ce0`  
Последний кодовый commit: `ca726301c827a5eb4199592864fd4d83a2e6b2bc`  
Статус: accepted по bounded-приёмке; публикация выполняется через PR #1

## Выполнено

- Добавлены канонические JSON Schema Draft 2020-12 v1.0 для `Effect`, `ActionResult`, минимального `WorldState`, `SceneFrame` и `PresentationPlan` в `packages/contracts/schemas/v1/`.
- Версия и `$id` схем закреплены публичными `CONTRACT_SCHEMA_VERSION` / `CONTRACT_SCHEMA_IDS`.
- Неизвестные поля запрещены; неподдерживаемая `schemaVersion` не приводится молча к текущей.
- TypeScript DTO первого слоя и публичный guard `ActionResult` синхронизированы с проверяемыми fixtures; B01-01 имя `ActionResultEnvelope` сохранено совместимым alias/экспортом.
- Добавлены отдельные semantic reference checks: позиция сущности/предмета должна ссылаться на существующий ID, а `dialogue.show.lineId` — на строку текущего `SceneFrame`.
- `PresentationPlan` пока рекламирует только конкретно специфицированные узлы первого примера: `sequence`, `parallel`, `actor.show`, `item.show`, `dialogue.show`.
- `WorldState` намеренно минимален; задачи, события, knowledge, RNG и extensions не объявлены готовыми раньше своих bounded-блоков.
- Core по-прежнему импортирует только публичный `@living-history/contracts` и не знает инфраструктуру.

## Проверено

GitHub Actions PR run [34021918840](https://github.com/conradipui-glitch/sandboxengine/actions/runs/34021918840) на Node `24.19.0`:

- `npm ci` → успешно;
- `npm run verify` → успешно;
- contract tests → 9/9 passed;
- Core tests → 2/2 passed;
- `check:boundaries` → успешно;
- `docs:check` → успешно.

Отдельно проверено различие shape/semantic validation: fixtures с несуществующим `locationId` и `dialogue lineId` проходят JSON Schema по форме, но отклоняются semantic reference checks.

## Не выполнено / ограничения

- B01 целиком ещё не завершён: нет канонических Block/Quest/ResolvedIntent, compile skeleton, endpoint readiness registry, генерации OpenAPI/Skill и двух полных fixture-пакетов.
- Runtime API, storage, LLM, Studio, Player, plugin SDK и Florence migration не начинались этим блоком.
- T01–T37 не считаются выполненными по контрактным fixtures B01-02.
- `npm ci` сообщил 2 dependency vulnerabilities (1 moderate, 1 high). Источник и безопасный способ устранения в рамках B01-02 не исследованы; не выполнять `npm audit fix --force` без отдельной проверки совместимости.

## Следующее действие

После публикации PR #1 выполнить [B01-03 — авторские схемы и минимальный пакет квеста](tasks/B01-03-authoring-schemas.md): Block envelope, минимальный QuestRelease, `ResolvedIntent` и целостный fixture-пакет. Не переходить к B02, пока общий B01 не закрыт по своей приёмке.

## Решения

- JSON Schema — источник истины для формы DTO; TypeScript-экспорты проверяются на общих fixtures.
- Cross-object ID membership — semantic validation поверх JSON Schema, а не выдуманный JSON Schema «foreign key».
- Необъявленные будущие поля/команды не считаются capabilities текущей версии.
