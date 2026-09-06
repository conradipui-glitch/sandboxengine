# Передача работы

Обновлено: 2026-09-06

Текущий блок: **B04-03 — Runtime HTTP, guest ownership и player-safe projection**  
База ветки: опубликованный B04-02 merge `a1ed4312406d4296f6e8742abcda7417437b1df7`  
Текущая ветка: `b04-03-runtime-http-guest-player-projection`  
PR: #14  
Статус: **B04-03 и общий B04 accepted по code/semantic/docs audit; остаётся final current-head PR gate → merge → push-CI main**

## Принятая база

- B03 published: merge `acb61b75b7b1fbcf782d6451a52230402e1d158d`, push-CI `34035223262`.
- B04-01 published: merge `c6e63be1bf9ac1998270220c6f8820a006b5c3ac`, push-CI `34036478296`.
- B04-02 published: merge `a1ed4312406d4296f6e8742abcda7417437b1df7`, push-CI `34037394667`.

Core остаётся authoritative для gameplay causality. `RuntimeStorage` остаётся authoritative для operation lifecycle/idempotency/fencing. HTTP не создаёт вторую state machine.

## Выполнено в B04-03

- Реальный `apps/server` TypeScript project на built-in `node:http`.
- Runnable entrypoint с созданием parent directory для SQLite на чистом старте.
- Отдельный `RuntimeGuestSessionAccess`; credential material не попадает в `WorldState`.
- Durable `SQLiteGuestSessionAccess` хранит SHA-256 verifier в отдельной access table.
- Owner verification выполняется до session/operation read и action mutation.
- Cross-owner и missing credential получают non-disclosing 404.
- `PlayerView` строится deny-by-default по explicit allowlist, не является raw `WorldState`.
- Public endpoints:
  - `GET /healthz`;
  - `POST /v1/sessions`;
  - `GET /v1/sessions/{sessionId}`;
  - `POST /v1/sessions/{sessionId}/actions`;
  - `GET /v1/sessions/{sessionId}/operations/{operationId}`.
- Первый transport action — только реально существующий `core.paint`.
- Server-side canonical SHA-256 request identity.
- `claimOperation` вызывается до Core; completed replay возвращается до executor.
- Persisted public response возвращается после commit и при retry/restart.
- Public operation projection не выдаёт lease/fencing/request hash/idempotency internals.
- Real SQLite busy отображается в `503 STORAGE_BUSY` без Core execution/partial operation.
- Malformed/oversize/unsupported body блокируется до Core.
- `test:server` входит в `npm run verify`.

## T15 и hardening

Functional/hardening CI `34038239722` — success.

Проверено:

1. T15 guest-owned deny-by-default PlayerView.
2. Guest B не может читать или мутировать session guest A.
3. Completed action retry с тем же key/body возвращает byte-equivalent persisted payload; executor count остаётся 1.
4. Different body under same key → `409 IDEMPOTENCY_KEY_REUSED`.
5. Wrong revision → `409 REVISION_CONFLICT` без Core execution.
6. Same processing request → `202`; другая команда при active operation → `409 ACTION_IN_PROGRESS`.
7. Public operation endpoint не раскрывает fencing/lease/request hash.
8. Guest credential hash-at-rest, plaintext credential не хранится в access row.
9. Restart сохраняет guest ownership и completed replay без второго Core execution.
10. Real SQLite lock → `503 STORAGE_BUSY`, state/operation/Core не меняются.

## Generated API contract

Endpoint registry переведён в `available` только для пяти реально работающих Runtime операций. `/v1/quests` и Control API остаются `planned`.

Generator теперь переносит `successStatus`; `POST /v1/sessions` публикуется как 201. Generated OpenAPI/capabilities/compatibility/SKILL синхронизированы.

Publication generated-doc gate: `34039363270` — success. Registry hash: `d51b498ca8aa0ea6f19bd09f13dad1b289827ce7506591b25d6ec15e5464d6ff`.

## Canonical B04 audit

На текущем PR-state одновременно проходят:

- T10 durable idempotent replay;
- T11 single owner/no lost update;
- T12 crash/restart/fencing;
- T15 public ownership/projection/retry;
- contracts 35/35;
- Core 55/55;
- storage 20/20;
- server regressions;
- boundaries;
- generated docs.

Общий B04 принят по семантике. Published он становится только после final current-head PR #14 gate, merge и зелёного push-to-main CI.

## Решения

- ADR 0010 — B03 scheduler/replay closure.
- ADR 0011 — Runtime operation idempotency/lease/fencing + Memory reference semantics.
- ADR 0012 — durable SQLite RuntimeStorage + restart/fault/busy policy.
- ADR 0013 — Runtime HTTP guest ownership / PlayerView / public endpoint boundary.

## Следующее действие

1. Получить final current-head CI PR #14 уже вместе с ADR/STATUS/HANDOFF/worklog/generated docs.
2. Если green — merge PR #14 без новых branch commits.
3. Проверить push-to-main CI на merge SHA.
4. Только после зелёного `main` открыть новый branch от этого merge и перечитать canonical следующий блок SPEC до создания task-card.
5. Не переносить в B04 будущие Studio/animation-suggestion изменения.

## Что не делать до завершения publication gate

- не начинать B05/B06 код в PR #14;
- не добавлять free-text intent/narrator/provider API;
- не добавлять Studio/Control API;
- не добавлять Florence-specific code;
- не менять B03/B04 storage semantics;
- не делать `npm audit fix --force` внутри B04 closure.

Известное наблюдение: `npm ci` сообщает 2 vulnerabilities (1 moderate, 1 high); отдельный dependency audit нужен позже.
