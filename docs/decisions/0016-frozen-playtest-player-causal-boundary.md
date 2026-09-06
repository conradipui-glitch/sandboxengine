# ADR 0016 — Frozen playtest как причинная граница Player

Дата: 2026-09-07  
Статус: accepted в B05-03 после final gate

## Контекст

B05-01 дал immutable frozen playtest, а B05-02 — человеческий Studio поверх authoritative Control API. До B05-03 между ними и gameplay Runtime оставался критический разрыв: опубликованный B04 minimal Runtime использовал compatibility `core.paint` definition (`blue_paint`, cost=1) внутри server executor. Такой hardcode достаточен для B04 transport/idempotency tests, но не может доказать, что изменение правила автором действительно меняет новую игру.

B05-03 должен соединить authoring и gameplay так, чтобы старый playtest оставался воспроизводимым, новый playtest получал новые правила, а Player никогда не вычислял последствия действия сам.

## Решение

### 1. Frozen playtest — единственный источник тестовой игровой версии

`@living-history/player` получает уже созданный `FrozenPlaytestRecord` и выполняет bounded bootstrap только из его immutable snapshot.

Bootstrap:

- не читает current draft;
- проверяет block shapes, duplicate ids и semantic references;
- строит initial `WorldState` из поддерживаемых `core.location`, `core.character`, `core.resource`;
- извлекает bounded `core.action/core.paint` definitions;
- создаёт pinned Runtime release identity из playtest id/content hash;
- отклоняет broken/unsupported snapshot вместо скрытого repair.

`draftRevision`, `WorldState.revision` и Runtime operation fencing по-прежнему остаются разными lifecycle.

### 2. Authored definition передаётся в существующий Core resolver

Для B05+ добавлен `createCoreExplicitActionExecutorForDefinition(definition)`.

Definition захватывается из frozen playtest и передаётся существующему `resolvePaintAction`. Player/browser не получает права вычислять расход, partial/executed/blocked или duration.

Старый `createCoreExplicitActionExecutor()` сохранён только как явный B04 compatibility factory для опубликованного minimal Runtime fixture. Новый author/playtest path не использует его hardcoded rule.

### 3. Player client владеет транспортом, но не причинностью

`RuntimePlayerClient` инкапсулирует публичный Runtime HTTP:

- create guest session;
- Bearer credential;
- expected revision;
- idempotency key;
- action request;
- refresh/reset.

Он валидирует фактический deny-by-default `PlayerView`, но не импортирует Core, ControlStore или SQLite и не симулирует gameplay.

### 4. Reset создаёт новую session из того же frozen template

Reset не перематывает mutable session и не читает current draft. Он создаёт новую Runtime guest session с тем же `templateId`, то есть с тем же frozen initial state и теми же frozen action definitions.

Поэтому draft edit после P1 не может изменить P1 или reset P1. Только новая validation + новый frozen P2 создают другую игровую версию.

### 5. Первый Player surface — безопасный projection, не presentation engine

`apps/player` показывает только bounded B05 surface:

- quest/location display metadata;
- player-safe resource value/unit;
- game elapsed time;
- integer quantity input;
- action result executed/partial/blocked;
- server-computed requested/completed/duration;
- reset.

В browser metadata намеренно нет `contentHash`, `compiledContentHash`, `resourceUnitsPerUnit` или raw compiled artifact. Стоимость действия не публикуется браузеру как источник client math.

Полные presentation plans/assets/animations остаются B07.

### 6. Human author → Player bridge проходит через существующий Control API

После exact-current valid validation Studio может вызвать уже существующий Control endpoint создания playtest. Studio показывает frozen playtest id и локальную команду запуска Player.

Если draft позже изменяется, ранее созданный playtest визуально и семантически остаётся отдельной frozen revision.

Studio не читает и не пишет Player/Runtime storage напрямую.

### 7. Development exposure остаётся loopback-only

B05-03 Player dev server:

- слушает только loopback;
- проксирует только к loopback Runtime origin;
- раздаёт safe display metadata, static surface и compiled `RuntimePlayerClient`;
- не предвосхищает B09 auth/publish.

Studio process entrypoint также получил реальный process smoke; найденный compiled relative-import gap исправлен и теперь защищён regression-тестом.

### 8. Bounded limitation первого Player процесса

Текущий `dev:player` запускается для **одного `LH_PLAYTEST_ID`** и поднимает один Runtime template плюс один definition-bound executor.

Это сознательный B05 scope. Мы не заявляем, что один Runtime process уже умеет одновременно маршрутизировать разные action definitions для множества playtest templates/sessions. Если такой multi-template runtime понадобится, definition routing должен быть явно спроектирован по pinned session release, а не добавлен скрытым global map/hardcode.

## Каноническое доказательство

Один и тот же request `units=2`:

- P1: resource initial=2, cost=1 → `executed`, completed=2, duration=600s;
- reset P1 → снова те же правила и initial state;
- draft меняется cost 1→2;
- старый P1 остаётся cost=1;
- P2 после новой validation: cost=2 → `partial`, completed=1, duration=300s;
- P1/P2 имеют разные content hashes;
- retry с тем же idempotency key не запускает Core второй раз.

Отдельный process test создаёт durable frozen cost=2 playtest, запускает настоящий `apps/player/dist/src/main.js`, выполняет action через Player proxy/Runtime/Core и проверяет reset.

## Последствия

Плюсы:

- авторское правило впервые причинно связано с реальным gameplay result;
- старые playtests воспроизводимы;
- Player остаётся тонким клиентом;
- Runtime idempotency/ownership/projection переиспользуются вместо второго gameplay stack;
- человеческий Studio→playtest→Player путь больше не требует ручного REST-запроса.

Цена:

- первый Player намеренно поддерживает один `core.paint` action surface;
- один dev Player process = один frozen playtest/template;
- нет B07 presentation/assets и B06 free text/LLM;
- запуск Player пока локальный и требует выбранного playtest id, а не B09 publish flow.

## Проверки решения

- deterministic frozen bootstrap;
- broken frozen snapshot rejected;
- Player package boundary запрещает Core/Control/storage imports;
- RuntimePlayerClient create/action/reset проходит реальный Runtime HTTP;
- canonical P1/P2 cost 1→2 causal E2E;
- old P1/reset P1 остаются cost=1;
- browser surface не содержит gameplay cost/compiled internals;
- real `dev:player` process starts from durable SQLite frozen playtest;
- real `dev:studio` process starts Control + Studio;
- Studio Control client создаёт frozen P1/P2 и old P1 не переписывается после draft edit;
- root `npm run verify` включает все regressions.

## Не решено этим ADR

Повторяемый onboarding/help — B05-04; multi-template published runtime/auth — позднее B09 или отдельный runtime slice; LLM — B06; presentation/assets/animations — B07; plugins — B08; animation suggestion assistant и Florence migration — последующие задачи.
