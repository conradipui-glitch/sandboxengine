# Статус движка

Последнее обновление: 2026-09-06. Источник краткого статуса — этот файл; подробности и решения находятся по ссылкам.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий и навигация | bootstrap и общий B01 приняты | B01-02 merge `270c98bd272dbe43879fb023df6e01f647782d35`, B01-03 merge `c9801e51f95498940fc4c03611637804d4db7a0b`, B01-04 code `b2570106e567fb34dfb63479e39e47ce87e21d22`, PR #3, CI `34023654191` |
| Контракты | B01 принят | 8 canonical JSON Schema v1.0, Ajv/semantic checks, `minimal-quest` + `transfer-desk`, generated agent contracts |
| Core | B01 compile skeleton принят; B02 ещё не начат | `compileQuest` проверяет version/refs, нормализует artifact и считает SHA-256; action resolver/state mutation отсутствуют |
| Compile/registry/generated docs | B01-04 принят | readiness registry; `docs:generate`; stale `docs:check`; OpenAPI содержит только `available` operations и сейчас имеет 0 paths |
| Runtime/API/storage | не начато | B04 после B02–B03 |
| Studio/Player | не начато | B05/B07 |
| AI-провайдеры, квоты, авторский помощник | не начато | B06/B10 |
| Плагины и Builder/GitHub | не начато | B08/B13 |
| Миграция Florence | не начато | B00/B11; baseline не заменяет миграцию |
| T01–T37 | не выполнены | B01 проверяет контрактный каркас; поведенческая матрица начинается с B02 |

## Что означает приёмка B01

Принят переносимый первый контрактный слой: схемы, DTO boundary, semantic references, два независимых package fixtures, deterministic compile artifact/hash, readiness registry и воспроизводимый agent kit. Planned HTTP endpoints присутствуют только в исходном registry и не экспортируются как доступные.

Приёмка B01 **не** означает, что игра уже исполняется. `ResolvedIntent` не меняет мир; `compileQuest` не исполняет действия; Runtime API, storage, scheduler, AI и Studio отсутствуют. Следующий bounded-шаг — `docs/tasks/B02-01-effects-atomicity.md`.

Известное наблюдение CI остаётся: `npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high). Их источник и безопасный upgrade ещё не исследованы; не выполнять `npm audit fix --force` без отдельной проверки совместимости.

Статус «готово» здесь означает наличие артефакта и проверяемого результата, а не написанный план.
