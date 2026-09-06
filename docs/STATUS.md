# Статус движка

Последнее обновление: 2026-09-06. Источник краткого статуса — этот файл; подробности и решения находятся по ссылкам.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий и навигация | B01 принят; B02-01 и B02-02 реализованы | B02-01 merge `82d554f1933087e95a08d97c2fa6625d3a5c93b3`; B02-02 code `9be90f57a1bcf0085095fc057e39244cc0a16c5c`, PR #5, CI `34024417932` |
| Контракты | `GameplayEffect` + `CalculatedAction` v1.0 | executable effect `resource.change`; calculated action `core.paint`; ADR 0003/0004 |
| Core effects | B02-01 принят | all-or-nothing `tryApplyEffectBatch` над trial-copy WorldState |
| Action resolver | B02-02 принят по bounded-приёмке | `resolvePaintAction`: executed/partial/blocked, resource limit, calculated duration; no clock/revision commit |
| Conditions/остальные базовые effects | не реализованы | следующий B02-03 — declarative preconditions + item transfer/ownership atomicity |
| Scheduler/time/tasks | не начато | B03 после общей приёмки B02 |
| Runtime/API/storage | не начато | B04 |
| Studio/Player | не начато | B05/B07 |
| AI-провайдеры/свободный ввод | не начато | B06 |
| Плагины/Builder | не начато | B08/B13 |
| Миграция Florence | не начато | B11 |
| T01–T37 | частично | T01 Core-ядро принято B02-02; atomic часть T07 доказана B02-01; T02–04/T07 целиком ещё впереди |

## Что движок реально умеет сейчас

Для explicit resolved action `core.paint` Core читает авторитетный остаток ресурса и сам вычисляет фактически выполнимый объём. При `blue_paint=2`, запросе 8 единиц, цене 1 и 300 сек/единицу получается `partial`: completed=2, duration=600, effect delta=-2. Повтор на состоянии с paint=0 даёт `blocked`, duration=0, effects=[].

Это ещё не игровой ход в runtime: рассчитанная duration не двигает clock, revision не увеличивается, storage commit отсутствует. Свободный текст и LLM не подключены. `ResolvedIntent` приходит уже готовым и не может сам задавать duration/effects.

Публичный B01 `ActionResult` v1.0 не переписан. Gameplay calculation использует отдельный strict `CalculatedAction` v1.0; см. ADR 0004.

Известное наблюдение CI: `npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high); force-upgrade без отдельной проверки не выполнялся.
