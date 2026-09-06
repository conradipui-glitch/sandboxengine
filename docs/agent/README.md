# Контекст для агента

Это короткая человеческая точка входа. Сначала прочитай [README](../../README.md), [STATUS](../STATUS.md), [HANDOFF](../HANDOFF.md) и карточку текущей задачи. Полное ТЗ — [docs/SPECIFICATION.md](../SPECIFICATION.md). Машинно собранный текущий контракт находится в [SKILL.md](SKILL.md).

## Текущая лестница причинности

Не смешивай разные обязанности:

1. `ResolvedIntent` — что понял ввод; без duration/effects/state mutation.
2. `Condition` — чистая проверка предпосылки по authoritative `WorldState`.
3. Action/social resolver — что реально возможно и какой смысл имеет explicit действие.
4. `CalculatedAction` — строгий рассчитанный outcome.
5. `tryApplyEffectBatch` — all-or-nothing typed world mutation на trial state.
6. `planTimeAdvance` — B03-01: static integer interval и deterministic event order.
7. `processTimeAdvancePlan` — B03-04: dynamic deterministic processing initial + generated events на trial state с bounded budget.
8. `projectTaskEvents` / `projectDeadlineEvent` — authored task/deadline → strict scheduler events.
9. Terminal semantics — previous effects учитываются, terminal останавливает interval в своём timestamp, later due events остаются unprocessed.
10. Functional `lcg32-v1` RNG + `buildSchedulerReplayFingerprint` — explicit provenance и deterministic replay/hash.
11. B04 добавляет persistence/runtime вокруг уже принятого Core transition; он не должен рассчитывать новую причинность.

## Принятые capabilities после B03

Gameplay effects: `entity.move`, `item.transfer`, `resource.change`.

Conditions: `resource.atLeast`, `entity.at`, `item.heldBy`, `all`, `any`, `not`.

Social acts: `request`, `permission`, `response (accept|refuse)`.

Calculated actions: `core.paint`, `core.social.request`, `core.social.permission`, `core.social.response`.

Scheduler events:

- `core.marker` — strict `ScheduledEvent:1.0`;
- `core.effects` — separate strict `ScheduledEffectEvent:1.0`;
- `core.terminal` — separate strict `ScheduledTerminalEvent:1.0`.

Scheduled task: `core.task` — strict `ScheduledTask:1.0`.

Generated `capabilities.json` — машинный источник реально опубликованных типов. Planned HTTP operations всё ещё не являются available до B04.

## Принятые B03 invariants

- только integer absolute elapsed seconds; Core не использует `Date`/timezone/wall-clock;
- static planning interval inclusive `[start,end]`;
- deterministic static order;
- fixed first-release priority policy: world `10`, task/step completion `20`, deadline `100`; synthetic task-start internal order `19`;
- past/duplicate/overflow/event-limit — explicit failure;
- event effects проходят только через единый atomic `tryApplyEffectBatch`;
- `entity.move` переносит только existing entity → existing location;
- dynamic child handler получает frozen snapshot и возвращает только strict `SchedulerEvent[]`;
- child на том же timestamp не может перескочить перед parent: effective priority не ниже parent + monotonic sequence;
- один `maxSteps/maxEvents` считает initial и generated processing;
- failure не возвращает partial candidate state;
- normal success: clock=`plan.end`, revision+1 ровно один раз;
- terminal success: clock=terminal timestamp, revision+1, later due events → `unprocessedEvents`;
- task/deadline projection pure и deterministic;
- RNG state/provenance explicit и repeatable;
- replay fingerprint использует существующий `canonicalStringify` + SHA-256.

Canonical B03 acceptance доказана T05/T06/T08 и replay regressions; решение — ADR 0010.

## Следующий блок — B04

B04 начинается только после merge PR #11 и зелёного push-CI `main`.

Канонический scope B04:

- Memory/SQLite storage contract;
- operation claim с `(sessionId, idempotencyKey, requestHash, expectedRevision)`;
- lease + monotonic fencing token;
- atomic commit candidate state + turn record + public response;
- recovery/idempotent response после lost HTTP response;
- Runtime API и player-safe projection;
- T10–12/T15.

Ключевой invariant: **Runtime/Storage не переписывает B03 scheduler semantics.** Оно сохраняет один уже рассчитанный candidate transition либо не сохраняет ничего.

## Что не делать в первом B04 slice

Не добавляй LLM, Studio, Player redesign, Florence migration, background realtime, Redis/queues, несколько storage adapters «на будущее» или generic plugin manager. Не держи SQLite write transaction открытой во время будущего LLM-вызова.

Сначала создай bounded B04 task-card с одним проверяемым риском вокруг operation/storage atomicity, затем код → regression → `npm run verify` → STATUS/HANDOFF/worklog.
