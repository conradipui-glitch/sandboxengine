# Контекст для агента

Это короткая человеческая точка входа. Сначала прочитай [README](../../README.md), [STATUS](../STATUS.md), [HANDOFF](../HANDOFF.md) и карточку текущей задачи. Полное ТЗ — [docs/SPECIFICATION.md](../SPECIFICATION.md). Машинно собранный текущий контракт находится в [SKILL.md](SKILL.md).

## Принятая лестница причинности

Не смешивай обязанности:

1. `ResolvedIntent` — что понял ввод; без duration/effects/state mutation.
2. `Condition` — чистая проверка предпосылок.
3. Action/social resolver — что реально возможно.
4. `CalculatedAction` — рассчитанный outcome.
5. `tryApplyEffectBatch` — atomic typed world mutation на trial state.
6. `planTimeAdvance` / `processTimeAdvancePlan` — детерминированное игровое время и события.
7. Task/deadline/terminal/RNG/replay — принятый B03 Core.
8. `RuntimeStorage` — публикует один уже рассчитанный candidate transition либо ничего; не создаёт новую игровую причинность.
9. `MemoryRuntimeStorage` задаёт semantic reference B04-01.
10. `SQLiteRuntimeStorage` воспроизводит те же semantics durable transaction/restart/fault cases B04-02.
11. B04-03 HTTP только аутентифицирует guest, валидирует transport input, вызывает существующий operation lifecycle и возвращает player-safe projection.

## Опубликованная база

- B03: merge `acb61b75b7b1fbcf782d6451a52230402e1d158d`, push-CI `34035223262`.
- B04-01: merge `c6e63be1bf9ac1998270220c6f8820a006b5c3ac`, push-CI `34036478296`.
- B04-02: merge `a1ed4312406d4296f6e8742abcda7417437b1df7`, push-CI `34037394667`.

## B04-03 — accepted branch, final publication gate

PR #14: `b04-03-runtime-http-guest-player-projection`.

Реализовано:

- guest credential/verifier отделён от `WorldState`;
- durable verifier хранится hash-at-rest;
- owner check выполняется до read/mutation;
- deny-by-default `PlayerView` вместо raw `WorldState`;
- `GET /healthz`;
- `POST /v1/sessions`;
- `GET /v1/sessions/{sessionId}`;
- `POST /v1/sessions/{sessionId}/actions`;
- `GET /v1/sessions/{sessionId}/operations/{operationId}`;
- server-side SHA-256 request identity;
- только explicit `core.paint` без B06 LLM;
- completed retry возвращает persisted response без второго Core execution;
- operation projection не выдаёт lease/fencing/request hash;
- real SQLite busy → 503 без Core/partial operation;
- restart сохраняет ownership и replay;
- malformed/oversize/cross-owner mutation не достигают Core.

Functional/hardening CI `34038239722` — success.

Generated API publication gate `34039363270` — success. Machine contract рекламирует ровно пять реализованных Runtime endpoints; `/v1/quests` и Control API остаются planned. Registry hash: `d51b498ca8aa0ea6f19bd09f13dad1b289827ce7506591b25d6ec15e5464d6ff`.

Решение: ADR 0013.

## Canonical B04 acceptance

На одном B04-03 state подтверждены:

- T10 durable idempotent replay;
- T11 one active owner / no lost update;
- T12 crash/restart/fencing;
- T15 guest ownership / PlayerView / HTTP retry;
- Core boundaries clean;
- generated docs current.

Поэтому B04 принят по code/semantic/docs audit, но считается опубликованным только после final current-head PR #14 gate, merge и зелёного push-CI `main`.

## Критическая public boundary

Не выдавай Player:

- raw `WorldState`;
- lease expiry/service clock;
- fencing token/counter;
- request hash;
- DB rows/schema errors/stacks;
- hidden state/future queue/private knowledge;
- provider secrets.

HTTP retry completed operation должен вернуть сохранённый public response **без второго Core execution**.

Guest B не может читать/менять session guest A. Ownership проверяется server-side, не UI.

## Следующая работа

До публикации PR #14 ничего нового не реализовывать.

После зелёного push-CI `main`:

1. создать новый branch от проверенного B04 merge;
2. перечитать следующий canonical блок `docs/SPECIFICATION.md`;
3. создать bounded task-card до кода;
4. будущую automatic animation suggestion идею оформить только в Studio/Presentation change set, не возвращать её в B04 Runtime.

## Не делать

- free-text intent/narrator/provider API до B06;
- Studio/Control editing API внутри Runtime PR;
- Florence-specific logic;
- Redis/queues/WebSocket/background realtime;
- public account platform;
- debug raw-state mutation endpoint;
- изменения B03 scheduler/action/effect semantics;
- force dependency upgrade без отдельного аудита.

## Минимальный цикл

Один bounded slice → реальные regressions → `npm run verify` → ADR/STATUS/HANDOFF/worklog → PR gate → merge → push-CI. Не переходить к следующему блоку до зелёного main.
