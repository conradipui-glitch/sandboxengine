# Статус движка

Последнее обновление: 2026-09-06. Источник краткого статуса — этот файл; подробности и решения находятся по ссылкам.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий и навигация | B01 и общий B02 приняты | B02-01 merge `82d554f1933087e95a08d97c2fa6625d3a5c93b3`; B02-02 merge `b675fbd7e2e9ad8f583d20faeeed2b1ccbb3b9ed`; B02-03 merge `2bb15df2f5bb493828ea59c796e776cf01e259fc`; B02-04 code `be9c2d76f2b30252c72ed4044010f3623b1664eb`, PR #7, CI `34029126259` |
| Контракты | B02 принят | strict `GameplayEffect`, `Condition`, `SocialAct`, `CalculatedAction` v1.0; generated capabilities current |
| Core action execution | B02 принят | read-only authoritative input, explicit resolver, trial effect batch, executed/partial/conditional/blocked |
| Resources/items | B02 принят | `resource.change`, `item.transfer`, mixed batch atomicity T07 |
| Conditions | B02 принят | resource/entity/item predicates + all/any/not; false отделён от broken reference |
| Player/social agency | B02 принят | request ≠ permission ≠ response; request conditional; accept/refuse explicit; no hidden physical effects |
| B02 test matrix | accepted | T01, T02, T03, T04, T07 реализованы детерминированно без AI |
| Scheduler/time/tasks | следующий блок | B03-01 — integer clock + ordered scheduler plan; B03 целиком отвечает за T05–06/T08 |
| Runtime/API/storage | не начато | B04 после B03 |
| Studio/Player | не начато | B05/B07 |
| AI-провайдеры/свободный ввод | не начато | B06; модель должна отображать текст на уже существующие Core-смыслы |
| Плагины/Builder | не начато | B08/B13 |
| Миграция Florence | не начато | B11 |

## Что означает приёмка B02

Core уже умеет без AI:

- вычислить explicit `core.paint` по authoritative ресурсу;
- вернуть `executed`, `partial` или `blocked` и рассчитанную duration;
- проверить декларативные preconditions;
- trial-применить typed resource/item effects all-or-nothing;
- сохранить request как `conditional`, пока нет explicit response;
- отличить permission от request;
- записать explicit accept/refuse без автоматического выполнения proposed action.

Опорные регрессии:

- T01: paint=2, request=8 → partial 2, −2 paint, 600 sec; повтор → blocked 0 sec;
- T02: «оставить мне копию» → pending request, без обратного item transfer;
- T03: «не запрещаю передать ответ» → permission `core.message.relay`, не новая просьба о переносе;
- T04: request остаётся conditional до explicit accept/refuse; response не исполняет physical action;
- T07: валидный resource effect перед ошибочным item transfer отклоняется целиком.

B02 всё ещё не является runtime: duration пока не двигает `WorldState.clock`, revision не увеличивается, pending social request не хранится в БД, фоновые задачи/events отсутствуют. Это граница B03/B04.

Известное наблюдение CI: `npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high); force-upgrade без отдельной проверки не выполнялся.
