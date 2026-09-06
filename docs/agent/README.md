# Контекст для агента

Сначала прочитай [README](../../README.md), [STATUS](../STATUS.md), [HANDOFF](../HANDOFF.md), текущую task-card и `docs/SPECIFICATION.md`. Машинный API/capabilities contract — [SKILL.md](SKILL.md).

## Принятая лестница границ

1. Core считает причинность.
2. Runtime публикует gameplay transition/idempotency/fencing.
3. Control редактирует quest draft и создаёт validation/frozen playtest.
4. Studio — **только клиент Control API**.
5. Player bootstrap читает **только frozen playtest**, а Player client — только public Runtime surface.
6. Player не является simulator: никакой client-side gameplay math.

Не смешивать `draftRevision`, `WorldState.revision` и Runtime fencing/lease.

## Published база

B01–B04 published.  
B05-01 published: `07aacacb68178c119d11b555a8c166ebe65fe791`; push-CI `34047090138`.  
B05-02 published: `b45a4fa5e930a893df755797c8b6668ec74ae7f6`; push-CI `34049166381`.

## Текущая работа — B05-03

Ветка: `b05-03-basic-player-frozen-playtest-e2e`. PR #17.  
Карточка: [B05-03](../tasks/B05-03-basic-player-frozen-playtest-e2e.md).  
ADR: [0016](../decisions/0016-frozen-playtest-player-causal-boundary.md).  
Worklog: [B05-03](../worklog/2026-09-07-b05-03.md).

B05-03 functional gates green; ещё нужны final docs/current-head gate → merge → main push-CI.

## Что уже доказано B05-03

### Frozen causal path

P1:

- initial resource=2;
- frozen cost=1;
- request units=2;
- result executed2 / 600s.

После draft edit cost=2:

- P1 и reset P1 остаются cost=1;
- P2 получает cost=2;
- тот же request units=2 → partial1 / 300s;
- P1/P2 hashes разные.

Retry того же committed request не вызывает Core второй раз.

### Player boundary

`@living-history/player`:

- deterministic bootstrap from frozen snapshot only;
- fail closed на broken snapshot;
- `RuntimePlayerClient` owns revision/idempotency/Bearer transport;
- не импортирует Core/Control/storage.

`apps/player`:

- safe resource/time/result/reset UI;
- browser не содержит gameplay cost arithmetic;
- real `dev:player` process загружает exact `LH_PLAYTEST_ID` из durable Control SQLite;
- Player/Runtime development listeners loopback-only.

### Studio bridge

После current valid validation Studio может:

1. создать frozen playtest через Control API;
2. получить playtest id;
3. показать PowerShell/macOS/Linux launch command;
4. сохранить старый frozen playtest неизменным после дальнейшего draft edit.

### Process-level regressions

Оба real entrypoints теперь проверяются spawn-smoke:

- `apps/studio/dist/src/main.js`;
- `apps/player/dist/src/main.js`.

В B05-03 process audit был найден и исправлен реальный B05-02 Studio compiled relative-import gap. Не удалять эти tests как «лишние».

## CI evidence

- `34052572989` — Player semantic/client green;
- `34053500773` — Player UI/process green;
- `34053598431` — Studio + Player real process smoke green;
- `34053894740` — Studio frozen P1/P2 bridge green.

## Критические запреты

- Player не читает current draft.
- Player не вычисляет resource spend/status/duration.
- Не публиковать raw compiled artifact/content hashes browser surface.
- Reset не переключает автоматически на новый draft/playtest.
- Не превращать B04 compatibility hardcode в authored path.
- Не заявлять multi-template Runtime routing: текущий dev Player process = один frozen playtest/template/definition.
- Не открывать Control/Studio/Player non-loopback до B09 auth.

## Следующее после publication B05-03

[B05-04 — Repeatable onboarding + persistent help / T29](../tasks/B05-04-repeatable-onboarding-help-t29.md).

B05-04 должен добавить always-accessible Help и повторяемый deterministic tour без AI calls и без canonical mutations. После него провести общий B05 author→Player audit; только после green merge/main CI переходить к B06.

## Не делать сейчас

B05-04 implementation внутри PR #17; LLM/free text; B07 assets/presentation; plugins; auth/publish; animation suggestions; Florence migration; force dependency upgrade.

## Минимальный цикл

Bounded slice → real regressions → `npm run verify` → ADR/STATUS/HANDOFF/worklog → final PR gate → merge with expected head → push-CI → новая ветка от green main.
