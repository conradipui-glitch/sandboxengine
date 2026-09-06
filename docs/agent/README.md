# Контекст для агента

Это короткая человеческая точка входа. Сначала прочитай [README](../../README.md), [STATUS](../STATUS.md), [HANDOFF](../HANDOFF.md) и карточку текущей задачи. Полное ТЗ — [docs/SPECIFICATION.md](../SPECIFICATION.md). Машинно собранный текущий контракт находится в [SKILL.md](SKILL.md).

## Принятая лестница причинности

Не смешивай обязанности:

1. `ResolvedIntent` — что понял ввод; без duration/effects/state mutation.
2. `Condition` — чистая проверка предпосылок.
3. Action/social resolver — что реально возможно.
4. `CalculatedAction` — рассчитанный outcome.
5. `tryApplyEffectBatch` — atomic typed world mutation на trial state.
6. Scheduler/tasks/deadline/terminal/RNG/replay — принятый B03 Core.
7. `RuntimeStorage` — публикует один уже рассчитанный candidate transition либо ничего.
8. Memory/SQLite B04 storage — operation lifecycle/idempotency/fencing, не gameplay logic.
9. B04 HTTP — guest ownership + transport validation + player-safe projection, не raw state.
10. B05 authoring/control — редактирует **quest draft**, а не `WorldState` живой игровой сессии.

## Опубликованная база

B01–B04 published.

Последняя точка: B04 merge `3ef8633cff0c07339e09107e4f3653f7e7295f0f`, push-CI `34039569962` — success.

B04 guarantees:

- durable idempotent replay;
- one active operation + fencing;
- crash/restart recovery;
- guest ownership;
- deny-by-default PlayerView;
- explicit Runtime HTTP;
- T10–12/T15;
- five available Runtime endpoints only;
- Core does not import Runtime.

## Текущая задача — B05-01

Карточка: [B05-01 — Draft Control foundation и frozen playtest snapshot](../tasks/B05-01-draft-control-frozen-playtest.md).

Canonical B05 — «Первый законченный путь автора». B05-01 закладывает server-side foundation до UI.

### Главный invariant

Draft — единственная редактируемая authoring truth.

- change set содержит `baseRevision`;
- stale revision не может перетереть новый draft;
- весь change set применим atomically;
- validation относится к exact draft revision/hash;
- playtest создаётся из immutable snapshot;
- дальнейшее редактирование draft не меняет уже созданный playtest.

### B05 decomposition

- B05-01 — draft/control/validation/frozen playtest;
- B05-02 — минимальные Studio forms;
- B05-03 — basic Player + frozen playtest E2E;
- B05-04 — help/onboarding/T29.

## Граница authoring vs gameplay

Не использовать gameplay `RuntimeStorage` как произвольный authoring CRUD.

Authoring records (`Project`, `QuestDraft`, validation, playtest snapshot) имеют собственный contract. Они могут использовать общий инфраструктурный SQLite позже, но не смешивают revision draft с `WorldState.revision`, service lease или gameplay operation fencing.

`draftRevision` — ревизия редактируемого контента. `WorldState.revision` — ревизия игровой сессии. Это разные счётчики и разные lifecycle.

## Следующий кодовый шаг

1. Инвентаризировать текущие `packages/` / `apps/server` boundaries.
2. Добавить отдельный authoring/control package или столь же явную package boundary.
3. Реализовать Memory reference semantics прежде HTTP.
4. Добавить regressions на stale revision, atomic change set, validation binding и frozen playtest.
5. Только после зелёного semantic gate расширять Control HTTP и registry readiness.

## Не делать в B05-01

- Studio UI;
- полный Player presentation interpreter;
- tutorial/help;
- free-text/LLM/author assistant;
- publish/release/rollback/roles/login;
- asset pipeline;
- animation suggestion assistant;
- Florence migration;
- raw gameplay state mutation;
- изменения B03/B04 semantics.

## Минимальный цикл

Один bounded slice → реальные regressions → `npm run verify` → ADR/STATUS/HANDOFF/worklog → PR gate → merge → push-CI. Не переходить к B05-02 до зелёного main B05-01.
