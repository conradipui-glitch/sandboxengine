# Передача работы

Обновлено: 2026-09-06

Текущий блок: B03-04 — closure of T05/T06/T08 and replay hash  
База ветки: B03-03 merge `53285ba13407c19678ef8f5163dadb63dad83b86`  
Последний functional priority-policy commit перед acceptance docs: `5cfe3f45dc6caf1af2c9dbfe120b35fc3cd5b38a`  
Статус: **общий B03 принят по canonical/code acceptance**; публикация выполняется через PR #11. Перед merge текущий head обязан пройти `npm run verify`; после merge нужен push-CI `main`.

## Что принято в B03 целиком

### B03-01 — static integer scheduler

- integer absolute elapsed seconds;
- inclusive `[start,end]`;
- deterministic static ordering;
- past/duplicate/overflow/event-limit failures;
- planning read-only.

### B03-02 — scheduled effects и atomic transition

- отдельный strict `ScheduledEffectEvent:1.0`;
- due effects применяются только через `tryApplyEffectBatch`;
- поздний effect failure отклоняет весь candidate transition;
- success коммитит clock/revision ровно один раз;
- future events остаются pending.

### B03-03 — tasks, terminal interruption и RNG

- strict `ScheduledTask:1.0`, kind `core.task`;
- pure deterministic `projectTaskEvents`;
- отдельный strict `ScheduledTerminalEvent:1.0`, kind `core.terminal`;
- `projectDeadlineEvent` без `Date`/wall-clock;
- terminal прерывает interval в своём timestamp и оставляет later due events `unprocessedEvents`;
- already-terminal state блокирует новый normal interval;
- explicit immutable `lcg32-v1` RNG state + provenance, без hidden entropy.

### B03-04 — canonical matrix closure

- strict `entity.move` как зарегистрированный `GameplayEffect:1.0` variant;
- existing entity → existing location через тот же atomic reducer;
- отдельный `processTimeAdvancePlan` для deterministic generated child events; B03-01 planner не переписан;
- handler получает frozen snapshot и может вернуть только strict `SchedulerEvent[]`;
- child in past / duplicate / invalid / handler failure → explicit failure без candidate state;
- один global `maxSteps/maxEvents` охватывает initial + generated processing;
- same-time child использует effective priority не ниже parent и monotonic sequence;
- fixed first-release policy: world event `10`, task/step completion `20`, deadline `100`; synthetic task-start internal order `19`;
- deterministic scheduler replay fingerprint переиспользует `canonicalStringify` + SHA-256.

## Canonical acceptance B03

Final functional PR #11 CI run `34034950071`, Node `24.19.0`, npm `11.17.0`:

- contract tests 35/35 passed;
- Core tests 55/55 passed;
- `check:boundaries` passed;
- `docs:check` passed.

Именованные доказательства из лога:

1. `T05 NPC returns at 900 inside work to 2400 and later step sees new location`.
2. `T06 completion at exact deadline uses canonical 20-before-100 priority and crosses midnight unambiguously`.
3. `T08 self-generated immediate events hit one global step budget with no partial commit`.
4. `B03 replay: same plan+seed yields identical ordered effects, final state and sha256 hash`.
5. `ScheduledTask projects canonical start/completion priorities`.
6. `deadline uses fixed priority 100` и noncanonical deadline priority отклоняется.

В PR diff отсутствуют `Math.random`, `Date` и timers. B03 не добавил HTTP/storage/LLM/background realtime.

Решение зафиксировано ADR 0010; подробный журнал — `docs/worklog/2026-09-06-b03-04.md`.

## Что B03 намеренно не делает

- persistence очереди/task/session state;
- operation idempotency;
- leases/fencing;
- Runtime/Control HTTP API;
- wall-clock/background simulation;
- LLM/NPC decisions;
- Studio/Player;
- generic plugin manager.

Это не долги B03, а границы следующих блоков.

## Следующее действие после merge/push-CI

Начать **B04 — persistent runtime и Runtime API** от чистого проверенного `main`.

Каноническая цель B04 из `docs/SPECIFICATION.md`:

- Memory/SQLite storage contract;
- `claimOperation(sessionId, key, requestHash, expectedRevision)`;
- lease + fencing token;
- atomic `commitTurn(expectedRevision, fencingToken, candidateState, turnRecord, publicResponse)`;
- `finishWithoutTurn` и `getOperation`;
- idempotent replay сохранённого ответа;
- Runtime API и ownership/player projection;
- fault-injection для crash-before-commit, crash-after-commit, stale lease/worker;
- T10–12/T15.

Критическая граница B04: persistence **не рассчитывает заново причинность** и не меняет scheduler priority/terminal semantics. Core даёт candidate transition; storage/runtime отвечает за единственный атомарный commit, конкуренцию, восстановление и безопасный transport.

Перед кодом B04 создать bounded task-card первого среза от этой канонической цели; не пытаться реализовать SQLite + HTTP + auth + concurrency одним неразделённым change set.

## Решения

- ADR 0003: executable GameplayEffect отдельно от generic Effect v1.0.
- ADR 0004: CalculatedAction отдельно от transport ActionResult.
- ADR 0005: declarative conditions и mixed atomicity.
- ADR 0006: request, permission, response — разные social semantics.
- ADR 0007: inclusive integer scheduler planning.
- ADR 0008: scheduled effects и whole-transition atomicity.
- ADR 0009: task projection, separate terminal interruption, explicit functional RNG.
- ADR 0010: dynamic generated-event processing, fixed 10/20/100 priorities и replay fingerprint закрывают общий B03.

## Известное наблюдение dependency layer

`npm ci` сообщает 2 dependency vulnerabilities (1 moderate, 1 high). Force-upgrade в B03 не выполнялся; это отдельная dependency-задача и не должно смешиваться с runtime semantics.
