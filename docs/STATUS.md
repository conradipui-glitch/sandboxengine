# Статус движка

Последнее обновление: 2026-09-06.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B05-01 published; B05-02 accepted на branch** | B05-01 main `07aacacb68178c119d11b555a8c166ebe65fe791`, push-CI `34047090138`; B05-02 PR #16 final docs gate → merge → main CI |
| Контракты/Core | B01–B03 приняты | deterministic actions/effects/conditions/social/scheduler/RNG/replay |
| Runtime storage/API | **B04 published** | idempotency/fencing/SQLite/guest HTTP; T10–12/T15 |
| Authoring / Control | **B05-01 published** | authoritative draft, validation, frozen playtest, loopback Control; ADR 0014 |
| Studio UI | **B05-02 accepted на branch** | human forms + baseRevision conflict UX + validation; ADR 0015 |
| Player basic author path | не начато | B05-03 |
| Onboarding/help | не начато | B05-04 / T29 |
| AI/free text | не начато | B06 |
| Presentation/assets | не начато | B07 |
| Plugins | не начато | B08 |
| Auth/publish | не начато | B09 |
| Author AI helper | не начато | B10 |
| Florence migration | не начато | B11 |

## Published B05-01

Main merge: `07aacacb68178c119d11b555a8c166ebe65fe791`.  
Push-CI: `34047090138` — success.

B05-01 гарантирует:

- отдельный `@living-history/control`;
- monotonic `draftRevision` и atomic change set по `baseRevision`;
- validation exact revision/contentHash;
- immutable frozen playtest;
- Memory + durable SQLiteControlStore;
- loopback-only Control HTTP;
- 13 available operations total / 11 HTTP paths;
- authoring lifecycle не смешан с `WorldState.revision` или Runtime fencing.

## B05-02 — accepted bounded slice на PR #16

Ветка: `b05-02-minimal-studio-forms`.  
Карточка: [B05-02](tasks/B05-02-minimal-studio-forms.md).  
Решение: [ADR 0015](decisions/0015-studio-control-client-boundary.md).

Реализовано:

- dependency-free TypeScript + DOM `apps/studio`;
- project/quest navigation/create;
- human forms `core.resource` и bounded `core.action/core.paint`;
- cost edit через `block.replace`;
- save всегда по authoritative `baseRevision`;
- 409 stale conflict загружает fresh draft и требует explicit retry/cancel;
- validation показывает revision/hash/status/errors и stale-report state;
- Studio и Control development listeners остаются loopback-only;
- same-origin Studio proxy не расширяет сетевую доступность Control;
- responsive mobile collapse и labelled forms;
- `test:studio` входит в root verify.

CI:

- `34048457576` — первый strict TypeScript failure, исправлен;
- `34048515006` — author semantics 3/4, найден static-root bug;
- `34048587043` — success, Studio 4/4;
- `34048643611` — success после compiled browser-entry smoke.

На последнем функциональном gate все прежние suites, boundaries и docs также green. Public API/registry не менялись.

Browser screenshot/fidelity automation этим slice не заявляется: новый Playwright/Chromium tooling намеренно не добавлялся ради bounded B05-02.

## Следующая задача после publication B05-02

[B05-03 — Basic Player + frozen playtest gameplay E2E](tasks/B05-03-basic-player-frozen-playtest-e2e.md).

Главное доказательство: P1 с cost=1 остаётся cost=1 после edit; новый P2 получает cost=2; одинаковый action request даёт другой deterministic gameplay result в новой test session; reset P1 не подхватывает current draft.

## Scope boundary

Не делать в текущем PR Player, onboarding, LLM, assets/presentation, plugins, auth/publish, animation suggestions или Florence migration.

Известно: `npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high); force-upgrade без отдельного аудита не выполнялся.
