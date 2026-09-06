# Передача работы

Обновлено: 2026-09-07

Текущий блок: **B05-03 — Basic Player + frozen playtest gameplay E2E**  
База: published B05-02 main `b45a4fa5e930a893df755797c8b6668ec74ae7f6`  
B05-02 push-CI: `34049166381` — success  
Ветка: `b05-03-basic-player-frozen-playtest-e2e`  
PR: #17  
Статус: **B05-03 functional gates green; осталось final docs/current-head gate → merge → push-CI main**

## Опубликованная база

B01–B04 published. B05-01/B05-02 published.

Authoring foundation:

- `@living-history/control`;
- Memory + durable SQLiteControlStore;
- `draftRevision` + atomic `baseRevision` changes;
- exact validation revision/hash;
- frozen playtest;
- loopback-only Control HTTP;
- Studio human forms/conflict UX/validation.

Не смешивать `draftRevision`, `WorldState.revision` и Runtime fencing/lease.

## Что реализовано в B05-03

### Player package boundary

`@living-history/player`:

- deterministic frozen bootstrap;
- initial WorldState только из frozen snapshot;
- bounded `core.paint` definitions из frozen action blocks;
- broken/unsupported snapshot rejected;
- `RuntimePlayerClient` для create/refresh/action/reset;
- никаких Core/Control/SQLite/storage imports из Player package.

### Author rule действительно доходит до Core

B04 minimal executor имел compatibility hardcode cost=1. Для authored/playtest path теперь используется `createCoreExplicitActionExecutorForDefinition(definition)`.

Definition захватывается из frozen playtest и передаётся существующему Core resolver. Player не вычисляет последствия.

Canonical causal result:

- P1: initial resource=2, cost=1, request2 → executed2 / 600s;
- reset P1 → снова те же frozen rules;
- draft edit cost=2;
- P1 остаётся cost=1;
- P2: request2 → partial1 / 300s;
- P1/P2 hashes различаются;
- idempotent retry не запускает Core второй раз.

### Minimal Player UI

`apps/player` показывает:

- quest/playtest identity;
- neutral scene/location text;
- player-safe resource;
- elapsed game time;
- bounded quantity;
- action result executed/partial/blocked;
- server-computed requested/completed/duration;
- Reset.

Browser не получает `resourceUnitsPerUnit`, raw compiled artifact или content hashes как источник gameplay logic.

### Real process composition

`npm run dev:player` требует `LH_PLAYTEST_ID` и читает exact durable frozen record из той же SQLite, что Studio/Control.

Process test:

1. создаёт реальный cost=2 frozen playtest;
2. запускает emitted `apps/player/dist/src/main.js`;
3. проходит RuntimePlayerClient через Player proxy;
4. получает partial1/300s;
5. reset возвращает resource=2/time=0.

Development listeners остаются loopback-only.

### Studio → frozen Player bridge

Studio после exact-current valid validation теперь может создать frozen playtest через существующий Control endpoint.

UI показывает:

- frozen playtest id;
- PowerShell команду запуска;
- macOS/Linux команду запуска;
- stale note, если draft изменился после frozen playtest.

Regression проверяет P1 cost=1 → edit cost=2 → persisted P1 остаётся cost=1 → P2 cost=2.

### B05-02 process gap, найденный аудитом

Во время B05-03 выяснилось, что реальный emitted Studio `main.js` имел неверную глубину relative import к server dist. Старые module/integration tests этого не ловили.

Исправлено через runtime URL к `apps/server/dist/control-server.js`. Добавлен permanent process smoke: реальный Studio process должен отдать `/` и proxied `/control/v1/projects`.

Это важная причина сохранять process-level tests в последующих UI slices.

## CI evidence

- `34052353562` — success, first causal frozen path;
- `34052452602` — PlayerView client validation bug найден;
- `34052572989` — success после исправления actual public PlayerView shape;
- `34053446362` — TypeScript narrowing gap найден;
- `34053500773` — success, Player UI + real process;
- `34053598431` — success, Studio/Player process smoke;
- `34053894740` — success, full Studio freeze bridge.

ADR: `docs/decisions/0016-frozen-playtest-player-causal-boundary.md`.  
Worklog: `docs/worklog/2026-09-07-b05-03.md`.  
Player runbook: `apps/player/README.md`.

## Bounded limitation

Один B05-03 `dev:player` process = один `LH_PLAYTEST_ID`, один Runtime template и один frozen paint definition.

Не расширять это молча до multi-template server. Если понадобится, definition routing проектируется явно по pinned session release.

## Publication sequence

1. Финальный PR #17 CI на current head с ADR/STATUS/HANDOFF/worklog/B05-04 card.
2. Если green — обновить PR body фактическими результатами без изменения head.
3. Merge #17 с expected current head SHA.
4. Проверить push-to-main CI именно на merge SHA.
5. Только после green main объявить B05-03 published.
6. Создать B05-04 branch **от verified B05-03 merge**.

## Следующая задача

[B05-04 — Repeatable onboarding + persistent help / T29](tasks/B05-04-repeatable-onboarding-help-t29.md).

Ключ: Help всегда доступна; onboarding можно повторить/пропустить; tour не вызывает AI/Control mutation/Runtime и не меняет canonical state. После B05-04 провести полный B05 author→Player audit.

## Не делать в PR #17

Onboarding implementation, LLM/free text, B07 presentation/assets, plugins, B09 auth/publish, animation suggestions, Florence migration и force dependency upgrade.
