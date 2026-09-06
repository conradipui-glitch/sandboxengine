# Статус движка

Последнее обновление: 2026-09-06. Источник краткого статуса — этот файл; подробности и решения находятся по ссылкам.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий и навигация | B01 принят; B02-01, B02-02 и B02-03 реализованы | B02-01 merge `82d554f1933087e95a08d97c2fa6625d3a5c93b3`; B02-02 merge `b675fbd7e2e9ad8f583d20faeeed2b1ccbb3b9ed`; B02-03 code `5c06e182614869d2f360389a0e5471facc236162`, PR #6, CI `34028543840` |
| Контракты | `GameplayEffect`, `Condition`, `CalculatedAction` v1.0 | effects: `resource.change`, `item.transfer`; conditions: resource/entity/item + all/any/not; action: `core.paint` |
| Core effects | B02-03 принят по bounded-приёмке | all-or-nothing `tryApplyEffectBatch` над trial-copy resources/items; T07 mixed batch доказан |
| Conditions | B02-03 принят | deterministic evaluator; valid false отделён от invalid/broken reference; no eval/JS expressions |
| Action resolver | B02-02 принят | `resolvePaintAction`: executed/partial/blocked, resource limit, calculated duration; no clock/revision commit |
| Social/player agency semantics | не реализованы | следующий B02-04 — request/permission/acceptance и `conditional` без LLM/scheduler |
| Scheduler/time/tasks | не начато | B03 после общей приёмки B02 |
| Runtime/API/storage | не начато | B04 |
| Studio/Player | не начато | B05/B07 |
| AI-провайдеры/свободный ввод | не начато | B06 |
| Плагины/Builder | не начато | B08/B13 |
| Миграция Florence | не начато | B11 |
| T01–T37 | частично | T01 Core-ядро принято B02-02; T07 принят B02-03; T02–04 следующие |

## Что движок реально умеет сейчас

Для explicit resolved `core.paint` Core сам рассчитывает выполнимый объём по authoritative resource state. При `blue_paint=2`, запросе 8 единиц, цене 1 и 300 сек/единицу получается `partial`: completed=2, duration=600, `resource.change delta=-2`. Повтор при paint=0 даёт `blocked`, duration=0, effects=[].

Отдельный `Condition` позволяет детерминированно проверить `resource.atLeast`, `entity.at`, `item.heldBy` и композиции `all/any/not`. Несуществующий ID считается ошибкой определения, а не обычным `false`.

`item.transfer` переносит уникальный item ровно в одну destination position (`location` или `holder`). Смешанный batch `resource.change` + ошибочный `item.transfer` целиком отклоняется: новый state не возвращается и первый расход не применяется.

Это всё ещё не runtime-ход: рассчитанная duration не двигает clock, revision не увеличивается, storage commit отсутствует. Свободный текст и LLM не подключены.

Известное наблюдение CI: `npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high); force-upgrade без отдельной проверки не выполнялся.
