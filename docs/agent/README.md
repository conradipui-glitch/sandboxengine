# Контекст для агента

Это короткая человеческая точка входа. Сначала прочитай [README](../../README.md), [STATUS](../STATUS.md), [HANDOFF](../HANDOFF.md) и карточку текущей задачи. Полное ТЗ — [docs/SPECIFICATION.md](../SPECIFICATION.md). Машинно собранный текущий контракт находится в [SKILL.md](SKILL.md).

## Принятая лестница границ

1. `ResolvedIntent` — что понял ввод.
2. Conditions/action/social resolvers — что реально возможно.
3. Gameplay effects + scheduler — deterministic Core causality.
4. `RuntimeStorage` — gameplay operation lifecycle/idempotency/fencing.
5. Runtime HTTP — guest ownership + player-safe projection.
6. `@living-history/control` — authoring draft lifecycle; он не меняет живой `WorldState`.
7. Studio — клиент Control API; прямого доступа к SQLite/quest files как к второй истине нет.

## Опубликованная база

B01–B04 published. B04 main: `3ef8633cff0c07339e09107e4f3653f7e7295f0f`; push-CI `34039569962` success.

## B05-01 — accepted branch, publishing gate

Карточка: [B05-01](../tasks/B05-01-draft-control-frozen-playtest.md).  
ADR: [0014](../decisions/0014-authoring-draft-frozen-playtest-control-boundary.md).

Принято на PR #15:

- separate `@living-history/control`;
- bounded `core.action/core.paint` authoring block;
- Memory + durable SQLite ControlStore;
- monotonic `draftRevision` and atomic `baseRevision` changes;
- exact revision/contentHash validation;
- frozen playtest snapshot + compiled artifact;
- restart/two-instance regressions;
- loopback-only Control HTTP;
- 8 Control operations advertised only after HTTP tests;
- total generated operations: 13; distinct paths: 11;
- planned `control.capabilities`/`agent-kit` remain hidden;
- registry hash `86d93105859f7c812f5d7e9f667a4d9bb3b01c2ab726fffd941b965197d97889`.

CI:

- semantic `34040472362` success;
- durable `34046137073` success;
- HTTP `34046356282` success;
- generated contract `34046749725` success.

Current matrix: contracts 37, Core 55, Runtime storage 20, Control 14, server 10 — all green, plus boundaries/docs.

B05-01 считается published только после final PR #15 docs gate, merge и green push-to-main.

## Критическая authoring boundary

Никогда не смешивай:

- `draftRevision`;
- `WorldState.revision`;
- Runtime fencing/lease.

Draft — единственная редактируемая истина. Validation принадлежит точному snapshot/hash. Frozen playtest не читает current draft после создания.

Control HTTP до B09 auth доступен только loopback. Не превращай наличие OpenAPI route в разрешение bind на `0.0.0.0`.

## Следующая работа после publication

[B05-02 — Minimal Studio forms поверх Control API](../tasks/B05-02-minimal-studio-forms.md).

Studio должна:

- работать через Control API;
- создавать project/quest;
- добавлять resource;
- создавать/редактировать bounded `core.paint`;
- сохранять по `baseRevision`;
- показывать stale conflict;
- запускать validation;
- восстанавливать state после reload с сервера;
- не требовать ручного JSON.

B05-03 затем соединит frozen playtest с базовым Player и докажет реальное изменение игрового результата.

## Не делать сейчас

- Player B05-03;
- onboarding B05-04;
- free-text/LLM B06;
- assets/presentation B07;
- plugins B08;
- roles/login/publish/network Control B09;
- author AI B10;
- animation suggestions;
- Florence migration;
- force dependency upgrade.

## Минимальный цикл

Один bounded slice → regressions → `npm run verify` → ADR/STATUS/HANDOFF/worklog → PR gate → merge → push-CI. Не начинать B05-02 до зелёного `main` B05-01.
