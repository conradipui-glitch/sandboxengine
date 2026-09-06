# Передача работы

Обновлено: 2026-09-06

Текущий блок: B02-04 — social/player-agency semantics  
Базовый commit: `2bb15df2f5bb493828ea59c796e776cf01e259fc`  
Последний кодовый commit: `be9c2d76f2b30252c72ed4044010f3623b1664eb`  
Статус: accepted по bounded-приёмке; общая приёмка B02 также пройдена; публикация выполняется через PR #7

## Выполнено

- Добавлен strict `SocialAct` v1.0: `request`, `permission`, `response`.
- Social subject хранит только `actionType`, `targetIds`, `args`; duration/effects/statePatch запрещены.
- `CalculatedAction` расширен `core.social.request`, `core.social.permission`, `core.social.response`.
- request всегда остаётся `conditional / AWAITING_RESPONSE`, effects=[].
- permission считается `executed` только как состоявшийся акт разрешения; permitted physical action не исполняется, effects=[].
- response содержит explicit `accept|refuse`, обязан ссылаться на конкретный known request и исходного адресата; effects=[].
- Даже acceptance не выполняет proposed physical action: item/resource mutation обязаны проходить обычный resolver/effect pipeline отдельно.
- Generated agent kit публикует social act types и social calculated action types; HTTP operations по-прежнему отсутствуют.
- Решение зафиксировано ADR 0006.

## Проверено

Первый PR run `34029050442` обнаружил TypeScript union regression после расширения `CalculatedAction`: старый paint helper использовал `Omit<CalculatedAction,...>` и потерял variant-specific поля; social `effects` выводились как `readonly never[]` вместо exact empty tuple. Семантика не менялась.

Fix commit `be9c2d76f2b30252c72ed4044010f3623b1664eb`:

- paint resolver теперь типизирован через `PaintCalculatedAction`;
- social outcomes используют конкретные calculated variants и exact `readonly []` effects.

Финальный GitHub Actions PR run [34029126259](https://github.com/conradipui-glitch/sandboxengine/actions/runs/34029126259), Node `24.19.0`, npm `11.17.0`:

- `npm ci` → успешно;
- `npm run verify` → успешно;
- contract tests → 28/28 passed;
- Core tests → 26/26 passed;
- `check:boundaries` → успешно;
- `docs:check` → успешно.

## B02 regression matrix

- T01 — resource-limited explicit action: принято B02-02.
- T02 — request «оставить копию» не превращается в inverse item transfer: принято B02-04.
- T03 — permission «не запрещаю передать ответ» не превращается в новую request/postpone: принято B02-04.
- T04 — request остаётся conditional до explicit accept/refuse; acceptance не исполняет proposed physical action: принято B02-04.
- T07 — mixed resource/item batch all-or-nothing: принято B02-03.

Каноническая карточка B02 требует typed conditions/effects, read-only inputs, trial effect batch, resolver, executed/partial/conditional/blocked и T01–04/T07. Эти пункты теперь имеют код и regression tests, поэтому общий B02 принят.

## Не выполнено / ограничения

- Duration пока не двигает `WorldState.clock` и не делает commit revision.
- Pending social requests не сохраняются в WorldState/storage; response resolver получает конкретный known request явным аргументом.
- NPC decision AI отсутствует.
- Tasks/events/deadlines/interruptions/RNG относятся к B03.
- Runtime API/storage/idempotency относятся к B04.
- Natural-language interpretation и LLM относятся к B06.
- `npm ci` продолжает сообщать 2 dependency vulnerabilities (1 moderate, 1 high); force-upgrade не выполнялся.

## Следующее действие

После публикации PR #7 начать [B03-01 — integer clock и ordered scheduler plan](tasks/B03-01-clock-event-queue.md). Не добавлять HTTP/storage/LLM. Первый scheduler slice должен доказать хронологический порядок событий внутри рассчитанной duration и стабильный tie-break, но не пытаться сразу реализовать весь task/deadline subsystem.

## Решения

- ADR 0003: executable GameplayEffect отдельно от generic Effect v1.0.
- ADR 0004: CalculatedAction отдельно от public transport ActionResult v1.0.
- ADR 0005: declarative Condition и mixed atomicity.
- ADR 0006: request, permission и response являются отдельными social semantics; consent не исполняет чужое действие.
