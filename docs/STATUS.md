# Статус движка

Последнее обновление: 2026-09-07.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B05-03 published; B05-04 functional gate green на PR #18** | B05-03 merge `158fbd3169d3402621faf079b39bd5e8dc8d0c69`, main CI `34055023933`; B05-04 audit CI `34055820343` success → final docs/current-head gate → merge/main CI |
| Контракты/Core | B01–B03 published | deterministic actions/effects/conditions/social/scheduler/RNG/replay |
| Runtime storage/API | **B04 published** | idempotency/fencing/SQLite/guest HTTP; T10–12/T15 |
| Authoring / Control | **B05-01 published** | authoritative draft, validation, frozen playtest; ADR 0014 |
| Studio UI | **B05-02/B05-03 published; B05-04 Help/Tour implemented** | human forms + frozen bridge + static repeatable onboarding |
| Player basic author path | **B05-03 published** | frozen bootstrap → Runtime/Core → Player UI/reset; ADR 0016 |
| Onboarding/help | **B05-04 accepted functionally на PR #18** | static Help, deterministic replayable tour, no AI/network mutation; ADR 0017 |
| AI/free text | не начато | B06 после публикации всего B05 |
| Presentation/assets | не начато | B07 |
| Plugins | не начато | B08 |
| Auth/publish | не начато | B09 |
| Author AI helper | не начато | B10 |
| Florence migration | не начато | B11 |

## Published B05-03 base

PR #17 merged в `main` как `158fbd3169d3402621faf079b39bd5e8dc8d0c69`.  
Push-CI на этом published main: `34055023933` — success.

Опубликованный B05-03 causal path:

- Studio validation → immutable frozen playtest;
- Player bootstrap только из frozen snapshot;
- authored `core.paint` definition доходит в Runtime/Core;
- P1 initial=2/cost=1/request2 → executed2/600;
- reset P1 остаётся на cost=1;
- draft edit cost=2 не меняет P1;
- P2 → partial1/300;
- idempotent retry не исполняет Core второй раз;
- browser не вычисляет gameplay cost/duration.

## B05-04 — final B05 slice

Ветка: `b05-04-repeatable-onboarding-help-t29`.  
PR: #18.  
Карточка: [B05-04](tasks/B05-04-repeatable-onboarding-help-t29.md).  
Решение: [ADR 0017](decisions/0017-static-repeatable-onboarding-boundary.md).  
Worklog: [2026-09-07 B05-04](worklog/2026-09-07-b05-04.md).

### Реализовано

- постоянная `? Справка` до проекта, внутри quest workspace и после onboarding;
- статический versioned vocabulary ровно по B05;
- 8-step deterministic tour поверх существующих Studio regions;
- Next / Back / Skip / explicit completion;
- replay через `Повторить обучение`;
- missing quest/validation/playtest объясняется prerequisite без synthetic data;
- completion/skipped хранится только как optional browser UX preference;
- localStorage failure-safe;
- Escape/focus return/keyboard buttons/mobile controls;
- onboarding module не использует `fetch` и не импортирует Control/Runtime/Player/Core/provider/LLM boundaries.

### T29 / canonical evidence

Implementation commit `aabb889de6523b2b340f91870b671408bf429822` прошёл PR CI `34055778084`.

Canonical audit commit `fd18beab06b0c47a6622ab5c76c6ad68baef4282` проходит в одном regression:

1. fresh Studio/Control;
2. project + quest/location;
3. resource initial=2;
4. paint cost=1;
5. validation + frozen P1;
6. P1 request2 → executed2/600;
7. idempotent retry без второго Core execution;
8. reset/new P1 session → executed2/600;
9. edit cost=2;
10. old P1 остаётся cost=1;
11. validation + frozen P2;
12. P2 request2 → partial1/300;
13. Help/onboarding bundle доступен;
14. onboarding no-fetch boundary закреплён тестом.

PR CI `34055820343` — **success**, root `npm run verify` green.

## Publication gate B05

До слова **published** для всего B05 остаётся:

1. final current-head CI после этой docs sync;
2. PR #18 merge с expected head;
3. push-to-main CI именно на merge SHA.

После этого B05 закрыт целиком, и следующий bounded block — B06 free-text/LLM intent + narration. Не смешивать B06 с PR #18.

## Scope boundary

Не добавлять в B05-04 LLM/free text, B07 presentation/assets/animations, plugins, auth/public publish, AI author helper, Florence migration или force dependency upgrade.

Известно: `npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high); force-upgrade без отдельного аудита не выполнялся.
