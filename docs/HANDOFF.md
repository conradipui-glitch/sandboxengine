# Передача работы

Обновлено: 2026-09-06

Текущий блок: B01-04 — compile skeleton, readiness registry и generated contracts  
Базовый commit: `c9801e51f95498940fc4c03611637804d4db7a0b`  
Последний кодовый commit: `b2570106e567fb34dfb63479e39e47ce87e21d22`  
Статус: accepted по bounded-приёмке и общей приёмке B01; публикация выполняется через PR #3

## Выполнено

- `packages/core/src/compile.ts` добавляет чистый `compileQuest`: версия контрактов и semantic references проверяются до создания результата.
- Валидный package нормализуется в один immutable artifact; блоки упорядочиваются по `release.blockIds`, canonical JSON сортирует ключи объектов и сохраняет порядок массивов.
- Content hash — SHA-256 через Web Crypto; одинаковое содержание даёт одинаковый hash, содержательное изменение меняет hash.
- Добавлен второй независимый fixture `packages/contracts/fixtures/transfer-desk/` («Стол находок»), не связанный с Florence.
- Добавлен `packages/contracts/registry/endpoints.json`: будущие HTTP-операции имеют readiness `planned`.
- Добавлены `npm run docs:generate` и generated `SKILL.md`, OpenAPI, capabilities, compatibility и schema index.
- Generated OpenAPI/capabilities включают только `available` operations. Сейчас Runtime/Control API не реализованы, поэтому OpenAPI `paths` пуст и operations list пуст.
- `docs:check` сравнивает committed generated files с детерминированной генерацией и падает при stale contract.
- Общий B01 принят: contract/schema boundary, semantic validation, два package fixtures, compile skeleton/hash, readiness registry и agent docs воспроизводимы.

## Проверено

GitHub Actions PR run [34023654191](https://github.com/conradipui-glitch/sandboxengine/actions/runs/34023654191), Node `24.19.0`, npm `11.17.0`:

- `npm ci` → успешно;
- `npm run verify` → успешно;
- contract tests → 18/18 passed;
- Core tests → 6/6 passed;
- `check:boundaries` → успешно;
- `docs:check` → успешно; 10 navigation docs + 5 generated contracts current.

Отдельно доказано тестами:

- оба fixture-пакета компилируются и дают стабильный 64-hex SHA-256;
- порядок входного массива blocks не меняет artifact/hash;
- изменение значения ресурса меняет hash;
- broken entry reference и incompatible version не выдают artifact;
- planned endpoint не появляется в generated OpenAPI/available capabilities;
- stale generated file обнаруживается тем же detector, который использует `docs:check`.

## Не выполнено / ограничения

- Action resolver, preconditions, typed gameplay effects и изменение WorldState ещё не реализованы; это B02.
- Scheduler/NPC tasks/deadlines — B03.
- Runtime API, storage, auth — B04; наличие planned endpoint registry не означает работающий HTTP.
- Studio/Player, AI, plugins, Builder и Florence migration не начинались.
- T01–T37 не считаются выполненными; B01 — инфраструктура контрактов, а не поведенческая приёмка игры.
- TypeScript DTO остаются schema-first ручными экспортами с parity tests, а не отдельной generated-code системой; это осознанная текущая граница B01, чтобы не заводить второй сложный генератор до независимого потребителя.
- `npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high); не исправлялись force-upgrade без отдельного анализа.

## Следующее действие

После публикации PR #3 начать [B02-01 — typed effects и атомарность](tasks/B02-01-effects-atomicity.md): заменить общий effect envelope первым реальным типизированным gameplay effect и реализовать пробное атомарное применение над копией WorldState. Не добавлять scheduler, HTTP или LLM.

## Решения

- `compileQuest` остаётся чистым Core-кодом и не читает файлы/БД/HTTP; загрузка package — ответственность будущего runtime/authoring adapter.
- Hash считается по canonical compiled content, а не по draft revision, времени сборки или пути файлов.
- Planned registry является источником планирования, но readiness gate запрещает выдавать planned operation агенту как доступную.
- B01 принят только в зафиксированном schema-first объёме; новые block kinds и runtime поля становятся capabilities лишь вместе с точной схемой и тестом.
