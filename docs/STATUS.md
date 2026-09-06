# Статус движка

Последнее обновление: 2026-09-06. Источник краткого статуса — этот файл; подробности и решения находятся по ссылкам.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий и навигация | B01 принят; B02-01 реализован | B01 merge `dd96e6f98377a358aad7785ffc96d3ece642e7d1`; B02-01 code `574cd80ffa7036f29bd0b5642c4ed6da2f80455b`, PR #4, CI `34024086353` |
| Контракты | `GameplayEffect` v1.0 добавлен без изменения generic `Effect` v1.0 | первый executable type `resource.change`; ADR 0003; generated capabilities обновлены |
| Core | B02-01 принят по bounded-приёмке | `tryApplyEffectBatch` применяет resource changes к trial-copy all-or-nothing; исходный state/revision/clock не мутируются |
| Compile/registry/generated docs | B01-04 принят и актуален | `docs:check` включает новый gameplay-effect schema; HTTP operations по-прежнему 0 available |
| Action resolver | не реализован | следующий шаг B02-02: explicit action definitions/resolver и рассчитанные `executed/partial/blocked` без scheduler |
| Scheduler/time/tasks | не начато | B03 после B02 |
| Runtime/API/storage | не начато | B04 |
| Studio/Player | не начато | B05/B07 |
| AI-провайдеры/свободный ввод | не начато | B06 |
| Плагины/Builder | не начато | B08/B13 |
| Миграция Florence | не начато | B11 |
| T01–T37 | частично подготовлены, не приняты целиком | B02-01 доказывает atomic effect batch — часть риска T07; полная поведенческая приёмка впереди |

## Текущая исполняемая граница

`resource.change` — первая механика, которая действительно способна вычислить новое значение игрового состояния. Она не является действием игрока сама по себе: Core пока не выбирает effect по `ResolvedIntent`, не считает длительность и не повышает revision. `tryApplyEffectBatch` — пробное чистое вычисление: success возвращает новый state, failure вообще не возвращает state.

Generic B01 `Effect` v1.0 сознательно не расширен. Исполняемые изменения идут через отдельный строгий `GameplayEffect` v1.0; см. `docs/decisions/0003-gameplay-effect-versioning.md`.

Известное наблюдение CI остаётся: `npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high). Их источник и безопасный upgrade ещё не исследованы; не выполнять `npm audit fix --force` без отдельной проверки совместимости.
