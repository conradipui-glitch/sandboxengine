# Статус движка

Последнее обновление: 2026-09-06. Источник краткого статуса — этот файл; подробности и решения находятся по ссылкам.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий и навигация | bootstrap, B01-01, B01-02 и B01-03 реализованы | B01-02 merge `270c98bd272dbe43879fb023df6e01f647782d35`; B01-03 code `08878f9db0598acf0db20a0aa48136f584f4ada1`, PR #2, CI `34022346033` |
| Контракты | B01-03 принят по bounded-приёмке | 8 canonical schemas v1.0, Ajv, semantic refs, minimal quest package; следующий шаг B01-04 |
| Core | versioned ActionResult без исполнения state | Core остаётся чистым от инфраструктуры; resolver B02 ещё не начат |
| Compile/registry/generated docs | не реализовано | B01-04 — compile skeleton, readiness registry, deterministic docs generation, второй fixture-пакет |
| Runtime/API/storage | не начато | B04 после B02–B03 |
| Studio/Player | не начато | B05/B07 |
| AI-провайдеры, квоты, авторский помощник | не начато | B06/B10 |
| Плагины и Builder/GitHub | не начато | B08/B13 |
| Миграция Florence | не начато | B00/B11; baseline не заменяет миграцию |
| T01–T37 | не выполнены | B01 fixtures проверяют контракты, но не являются приёмкой сценариев T01–T37 |

Принятые B01-03 границы:

- `Block` пока регистрирует только `core.location`, `core.character`, `core.resource`;
- минимальный `QuestRelease` ссылается на blocks устойчивыми ID и указывает contracts compatibility;
- `ResolvedIntent` не имеет права возвращать duration/effects/state mutation;
- `minimal-quest` является schema/semantic fixture, а не уже исполняемой игрой.

B01 в целом ещё не закрыт. Для его общей приёмки остаются compile skeleton, endpoint readiness registry, reproducible generated agent contracts/OpenAPI readiness и второй полный fixture-пакет.

Известное наблюдение CI остаётся: `npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high). Их источник и безопасный upgrade ещё не исследованы; не выполнять `npm audit fix --force` без отдельной проверки совместимости.

Статус «готово» здесь означает наличие артефакта и проверяемого результата, а не написанный план.
