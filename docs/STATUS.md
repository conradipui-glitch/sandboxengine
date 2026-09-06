# Статус движка

Последнее обновление: 2026-09-07.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B05-02 published; B05-03 accepted на branch** | B05-02 main `b45a4fa5e930a893df755797c8b6668ec74ae7f6`, push-CI `34049166381`; B05-03 PR #17 final docs gate → merge → main CI |
| Контракты/Core | B01–B03 приняты | deterministic actions/effects/conditions/social/scheduler/RNG/replay |
| Runtime storage/API | **B04 published** | idempotency/fencing/SQLite/guest HTTP; T10–12/T15 |
| Authoring / Control | **B05-01 published** | authoritative draft, validation, frozen playtest, loopback Control; ADR 0014 |
| Studio UI | **B05-02 published + B05-03 freeze bridge accepted** | human forms/conflict/validation + create frozen playtest; real process smoke |
| Player basic author path | **B05-03 accepted на branch** | frozen bootstrap → Runtime/Core → real Player UI/reset; ADR 0016 |
| Onboarding/help | не начато | B05-04 / T29 |
| AI/free text | не начато | B06 |
| Presentation/assets | не начато | B07 |
| Plugins | не начато | B08 |
| Auth/publish | не начато | B09 |
| Author AI helper | не начато | B10 |
| Florence migration | не начато | B11 |

## Published база B05-01 / B05-02

B05-01 main: `07aacacb68178c119d11b555a8c166ebe65fe791`; push-CI `34047090138`.  
B05-02 main: `b45a4fa5e930a893df755797c8b6668ec74ae7f6`; push-CI `34049166381`.

Опубликованный authoring path уже даёт:

- separate `@living-history/control`;
- monotonic `draftRevision` + atomic `baseRevision` changes;
- exact validation revision/contentHash;
- immutable durable frozen playtest;
- Memory + SQLite ControlStore;
- loopback-only Control HTTP;
- dependency-free TypeScript/DOM Studio;
- project/quest/resource/core.paint forms;
- explicit stale conflict UX без silent overwrite.

## B05-03 — accepted bounded slice на PR #17

Ветка: `b05-03-basic-player-frozen-playtest-e2e`.  
Карточка: [B05-03](tasks/B05-03-basic-player-frozen-playtest-e2e.md).  
Решение: [ADR 0016](decisions/0016-frozen-playtest-player-causal-boundary.md).  
Worklog: [2026-09-07 B05-03](worklog/2026-09-07-b05-03.md).

### Реализовано

- новый `@living-history/player` package;
- deterministic frozen-playtest bootstrap → initial `WorldState` + pinned release + bounded paint definitions;
- Player bootstrap не читает current draft и fail-closed на broken snapshot;
- authored/playtest Runtime executor получает definition из frozen playtest вместо B04 hardcoded cost;
- `RuntimePlayerClient` владеет create/refresh/action/reset transport, revision/idempotency/credential semantics;
- Player package не импортирует Core/Control/SQLite/storage;
- canonical cost 1→2 causal E2E;
- old P1/reset P1 остаются на старых правилах;
- real responsive `apps/player` surface: resource, time, quantity, result, reset;
- browser не вычисляет gameplay cost/duration и не получает compiled internals;
- `dev:player` запускается из exact durable `LH_PLAYTEST_ID`;
- Studio после valid validation создаёт frozen playtest и показывает launch commands;
- real `dev:studio` process smoke добавлен; найденный compiled import gap B05-02 исправлен.

### Каноническое доказательство

Одинаковый request `units=2` при initial resource=2:

- P1 cost=1 → `executed`, completed=2, duration=600s;
- reset P1 → тот же frozen cost=1;
- draft edit cost=2 не меняет P1;
- P2 cost=2 → `partial`, completed=1, duration=300s;
- P1/P2 content hashes различаются;
- idempotent retry не исполняет Core второй раз.

### CI evidence

- `34052353562` — success: первый frozen causal path;
- `34052452602` — пойман неверно угаданный PlayerView validator, исправлен по public contract;
- `34052572989` — success: RuntimePlayerClient + causal Player tests;
- `34053446362` — пойман strict TS narrowing в Player entrypoint, исправлен;
- `34053500773` — success: Player UI + real `dev:player` process;
- `34053598431` — success: real Studio + Player process smoke;
- `34053894740` — success: полный Studio validation → frozen P1/P2 bridge.

Финальный current-head docs gate, merge #17 и push-to-main CI ещё обязательны перед словом **published**.

## Bounded limitation B05-03

Один local `dev:player` process запускает один `LH_PLAYTEST_ID` / один Runtime template / один frozen `core.paint` definition. Multi-template definition routing в одном Runtime process пока не заявляется.

Player/Studio/Control development surfaces остаются loopback-only до B09 auth/publish.

## Следующая задача после publication B05-03

[B05-04 — Repeatable onboarding + persistent help / T29](tasks/B05-04-repeatable-onboarding-help-t29.md).

После B05-04 провести общий B05 canonical audit полного author→Player пути. Только после green merge/main CI B05 можно объявить полностью published и перейти к B06.

## Scope boundary

Не делать в текущем PR onboarding implementation, LLM/free text, B07 presentation/assets/animations, plugins, auth/publish, animation suggestion assistant, Florence migration или force dependency upgrade.

Известно: `npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high); force-upgrade без отдельного аудита не выполнялся.
