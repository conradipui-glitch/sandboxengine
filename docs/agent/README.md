# Контекст для агента

Сначала прочитай [README](../../README.md), [STATUS](../STATUS.md), [HANDOFF](../HANDOFF.md), текущую task-card и `docs/SPECIFICATION.md`. Машинный API/capabilities contract — [SKILL.md](SKILL.md).

## Принятая лестница границ

1. Core считает причинность.
2. Runtime публикует gameplay transition/idempotency/fencing.
3. Control редактирует quest draft и создаёт validation/frozen playtest.
4. Studio — **только клиент Control API**.
5. Player — следующий клиент frozen playtest/Runtime, не новый simulator.

Не смешивать `draftRevision`, `WorldState.revision` и Runtime fencing/lease.

## Published база

B01–B04 published.  
B05-01 published main: `07aacacb68178c119d11b555a8c166ebe65fe791`; push-CI `34047090138` success.

B05-01 guarantees authoritative draft, Memory/SQLite ControlStore, exact validation, frozen playtest и loopback Control HTTP.

## Текущая работа — B05-02

Ветка: `b05-02-minimal-studio-forms`. PR #16.  
Карточка: [B05-02](../tasks/B05-02-minimal-studio-forms.md).  
ADR: [0015](../decisions/0015-studio-control-client-boundary.md).

B05-02 functional/hardening gate green:

- TypeScript + DOM Studio без frontend framework dependency;
- project/quest forms;
- resource form;
- bounded core.paint form/cost edit;
- save по baseRevision;
- 409 → fresh draft + explicit retry/cancel;
- validation revision/hash/stale report;
- loopback same-origin Studio proxy;
- responsive labelled UI;
- `test:studio` в root verify;
- real SQLite + Control HTTP + Studio proxy integration;
- compiled browser entry smoke.

CI:

- `34048587043` success;
- `34048643611` success после hardening.

Public registry/API не менялись.

## Критические запреты

- Studio не пишет SQLite и files напрямую.
- Не хранить локальный quest JSON как authoritative copy.
- Не auto-retry stale changes.
- Не открывать Control/Studio non-loopback до B09 auth.
- Не переносить gameplay math в Studio/Player.
- Не добавлять несуществующие block types как доступные.

## Следующее после publication B05-02

[B05-03 — Basic Player + frozen playtest gameplay E2E](../tasks/B05-03-basic-player-frozen-playtest-e2e.md).

Ключевой тест B05-03:

P1 cost=1 → edit draft cost=2 → P1 и reset P1 всё ещё cost=1 → P2 cost=2 → одинаковый action request даёт другой deterministic Core/Runtime result.

Player first slice: текст/нейтральный фон/action button/result/reset. Полная presentation/animation system остаётся B07.

## Не делать сейчас

Player code до merge B05-02; onboarding; LLM; assets/presentation; plugins; auth/publish; animation suggestions; Florence migration; force dependency upgrade.

## Минимальный цикл

Bounded slice → real regressions → `npm run verify` → ADR/STATUS/HANDOFF/worklog → final PR gate → merge → push-CI → новая ветка от green main.
