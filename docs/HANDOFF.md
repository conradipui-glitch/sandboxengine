# Передача работы

Обновлено: 2026-09-07

Текущий блок: **B05-04 — Repeatable onboarding + persistent help / T29**  
База: published B05-03 merge `158fbd3169d3402621faf079b39bd5e8dc8d0c69`  
B05-03 push-CI main: `34055023933` — success  
Ветка: `b05-04-repeatable-onboarding-help-t29`  
PR: #18  
Статус: **functional + canonical audit gate `34055820343` success; docs sync → final current-head CI → merge/main publication gate**

## Что уже published

B01–B04 и B05-01/B05-02/B05-03 published.

B05-03 впервые завершил causal author→game path:

- authoritative Studio draft;
- validation;
- immutable frozen playtest;
- Player bootstrap только из frozen record;
- authored action definition → Runtime/Core;
- P1 cost=1 executed2/600;
- reset P1 остаётся cost=1;
- P2 cost=2 partial1/300;
- idempotent retry не запускает Core второй раз.

## Что реализовано в B05-04

### Persistent Help

Отдельный `apps/studio/src/onboarding.ts` добавляет постоянный `? Справка` entrypoint, доступный независимо от наличия/выбора project/quest.

Справка статическая и versioned. Она объясняет только существующий B05:

- project/quest;
- resource;
- bounded `core.paint`;
- save/revision/conflict;
- validation;
- frozen playtest;
- local Player launch;
- Reset = новая session из того же frozen playtest.

### Repeatable tour / T29

Tour состоит из 8 deterministic шагов и поддерживает Next/Back/Skip/completion/replay.

Критическая граница:

- нет `fetch`;
- нет Control/API import;
- нет Runtime/Player/Core import;
- нет provider/LLM import;
- tour не создаёт project/quest/blocks и не вызывает validation/freeze/action;
- missing prerequisite только объясняется;
- completed/skipped — optional localStorage UX preference, не canonical state.

Escape закрывает Help/tour; focus возвращается на Help trigger; mobile controls остаются доступны.

ADR: `docs/decisions/0017-static-repeatable-onboarding-boundary.md`.

## Canonical B05 audit

`apps/studio/test/b05-canonical-audit.test.mjs` теперь одним regression доказывает:

1. fresh Studio/Control;
2. project/quest/location;
3. resource initial=2;
4. cost=1 + validation + frozen P1;
5. P1 request2 → executed2 / 600s;
6. same idempotency key → тот же result, Core count=1;
7. reset/new P1 session → executed2 / 600s;
8. edit draft cost=2;
9. persisted old P1 всё ещё cost=1;
10. validation + frozen P2;
11. P1/P2 hashes differ;
12. P2 request2 → partial1 / 300s / RESOURCE_LIMIT;
13. onboarding bundle доступен и no-fetch.

Functional/audit head `fd18beab06b0c47a6622ab5c76c6ad68baef4282`.  
PR CI `34055820343` — **success**, root `npm run verify` green.

## B05-04 acceptance state

Закрыто функционально:

- Help always available;
- onboarding repeatable after completion/skip;
- deterministic static/versioned content;
- no AI/network/canonical mutation;
- optional failure-safe preference;
- anchor regression;
- accessibility minimum;
- full author→Player causal audit;
- existing Studio/Player regressions green.

Остался только Publication Gate:

1. final current-head PR CI после docs sync;
2. mark PR #18 ready;
3. merge с expected head SHA;
4. проверить push-to-main CI на merge SHA;
5. после green main объявить весь B05 published.

## Следующее после публикации B05

B06 — free-text/LLM intent + narration по canonical roadmap.

Создать отдельную bounded task-card и ветку **только от verified B05 merge SHA**. Не добавлять B06 в PR #18.

## Не делать сейчас

B06 implementation, B07 presentation/assets/animations, plugins, B09 auth/public publish, B10 AI author helper, Florence migration и force dependency upgrade.
