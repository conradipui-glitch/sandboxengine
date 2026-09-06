# Передача работы

Обновлено: 2026-09-06

Текущий блок: **B05-02 — Minimal Studio forms**  
База: published B05-01 main `07aacacb68178c119d11b555a8c166ebe65fe791`  
B05-01 push-CI: `34047090138` — success  
Ветка: `b05-02-minimal-studio-forms`  
PR: #16  
Статус: **B05-02 functional/hardening gates green; осталось final docs gate → merge → push-CI main**

## Опубликованная база

B01–B04 published. B05-01 также published и даёт authoritative authoring foundation:

- `@living-history/control`;
- Memory + durable SQLiteControlStore;
- `draftRevision` + atomic `baseRevision` changes;
- validation exact revision/hash;
- frozen playtest;
- loopback-only Control HTTP.

Не смешивать `draftRevision`, `WorldState.revision` и Runtime fencing/lease.

## Что реализовано в B05-02

### Studio boundary

`apps/studio` — клиент Control API, не база данных.

- не пишет SQLite/quest files;
- не держит самостоятельный quest JSON как вторую истину;
- successful save заменяет локальное view server snapshot;
- reload восстанавливает draft с Control API.

### UI

- проекты: list/create;
- квесты: list/create;
- initial location при создании quest;
- human `core.resource` form;
- bounded `core.paint` form и cost edit;
- validation revision/hash/status/errors;
- loading/saving/saved/error/conflict/Control-unavailable messages;
- labelled forms, focus restoration, responsive collapse до mobile viewport.

### Concurrency UX

Save всегда использует текущий `draftRevision` как `baseRevision`.

При `409 DRAFT_REVISION_CONFLICT`:

1. Studio получает fresh server draft;
2. stale change не применяется;
3. пользователь видит old→current revision;
4. retry или cancel — только явным действием;
5. silent last-write-wins запрещён.

### Development transport

Studio dev server и Control listener — loopback-only. Studio proxy принимает только loopback Control origin и делает same-origin `/control/*` для браузера. B09 network auth не предвосхищается.

### Dependency/tooling decision

B05-02 не добавляет React/Vite/Playwright/Chromium. Используется TypeScript + DOM и встроенный Node HTTP. Acceptance integration идёт через реальный SQLiteControlStore + Control HTTP + Studio proxy; compiled browser entry отдельно проверяется как раздаваемый JS.

Это не заявление о финальном visual polish/browser screenshot QA.

## CI evidence

- `34048457576` — найден BodyInit TypeScript mismatch, исправлен;
- `34048515006` — бизнес-сценарии прошли, найден static-root 404, исправлен;
- `34048587043` — success, Studio 4/4;
- `34048643611` — success после hardening.

На green gate также проходят contracts 37, Core 55, Runtime storage 20, Control 14, server 10, boundaries/docs.

ADR: `docs/decisions/0015-studio-control-client-boundary.md`.  
Worklog: `docs/worklog/2026-09-06-b05-02.md`.

## Publication sequence

1. Финальный PR #16 CI на current head с ADR/STATUS/HANDOFF/worklog/B05-03 card.
2. Если green — merge #16 с expected head SHA.
3. Проверить push-to-main CI на merge SHA.
4. Только после green main создать B05-03 branch от merge.

## Следующая задача

[B05-03 — Basic Player + frozen playtest gameplay E2E](tasks/B05-03-basic-player-frozen-playtest-e2e.md).

Нужно доказать не UI-иллюзию, а causal E2E:

- P1 frozen на cost=1;
- draft изменён на cost=2;
- P1/reset P1 остаются cost=1;
- P2 получает cost=2;
- одинаковый action request в новой test session даёт другой ожидаемый Core/Runtime result.

## Не делать в PR #16

Player, onboarding, LLM, B07 presentation/assets, plugins, auth/publish, animation suggestions, Florence migration и force dependency upgrade.
