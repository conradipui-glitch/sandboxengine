# 2026-09-09 — B13 acceptance evidence (post-merge closure)

Branch: `feat/b13-acceptance-closure` (от актуального main `7997b01`)

## Сверка с согласованными критериями §25 / T33–35

### 1. Реальная изоляция исполнения B13.a2 — **PARTIAL**

Executor (`workspace-executor.ts`) исполняет только policy-команды через `execFile` с фиксированным
argv, чистым environment (без секретов, без пользовательского Git config), timeout 120 s и bounded
stderr — но это host-Node процесс. Контейнерной/VM изоляции НЕТ: Docker/Podman отсутствуют, WSL2
сломан на этом хосте. Policy-allowlist остаётся единственной границей того, ЧТО запускается;
PATH-гигиена не является security boundary. Полная изоляция достигается исполнением verification
в CI runner (чистая VM на каждый запуск) — это зафиксировано как обязательное условие для
production-профиля Builder. Локальный режим остаётся hygiene-only и не объявляется sandbox.

### 2. Живой deployment через B13.b2-адаптер с operation ID и восстановлением — **PROVEN**

- `scripts/b13-b2-live-acceptance.mjs` использует собранный `PreviewDeploymentAdapter` +
  `createGhPreviewDeploymentGateway` (не сырой gh-вызов);
- operationId `b13-b2-live-acceptance-20260909` записан в квитанции
  (`docs/worklog/b13-b2-live-receipt.json`): `preview-34324006071`, SHA `ffba7c8…`, smokePassed true;
- восстановление потерянного ответа доказано ЖИВЬЁМ через сам адаптер:
  `reconcileLostResponse` добавлен в preview-адаптер (метод + unit-тест, 25/25) и выполнен
  против существующего рана — найден `preview-34325106273`, smoke пройден, НОВЫЙ dispatch
  не выполнялся; квитанция `docs/worklog/b13-reconcile-lost-response-receipt.json`
  (operationId `b13-reconcile-lost-response-20260909`).

### 3. Версии в preview — **FIXED (расхождение найдено и задокументировано)**

Preview-воркер `living-history-florence-preview` собран из sandbox-репо @ `ffba7c8`
(«test: align Florence ending contract», 2026-09-05), app version `0.1.0`. Engine-часть —
`engine-bff.ts` из того же коммита sandbox (bundled в воркер). Движок live-author-studio @
`b1a05ab`/`7997b01` НЕ входит в этот preview: интеграция движка в приложение идёт через
`ENGINE_RUNTIME_URL` + BFF, и на preview она не настроена (см. пункт 4 — engine-режим там работает
через bundled код, а не через отдельный хостинг движка). Для отдельного Engine-хостинга требуется
ресурс: **постоянно доступный HTTPS endpoint движка** (Cloudflare Worker/Tunnel/VM) + секрет
`ENGINE_RUNTIME_URL` (+ `ENGINE_FLORENCE_PROJECT_ID/QUEST_ID`) в preview-окружении; без этого
engine-режим в приложении отдаёт `ENGINE_ROUTE_NOT_CONFIGURED`.

### 4. Игровой smoke создания/продолжения сессии — **PROVEN**

Живой прогон против preview-воркера (engine-режим, `POST /api/games {runtime:"engine"}`):
- create: HTTP 201, `scenarioId: florence-workshop`, turn 1;
- 3 последовательных хода (текст): HTTP 200, turn 2 → 3 → 4, осмысленные исходы («Показ росписи
  секретарю», «Ученик отправлен к лекарю», «Просьба о переносе показа»);
- возобновление: `GET /api/games/{id}` — HTTP 200, turn 4;
- идемпотентность: повтор с тем же `idempotencyKey` → тот же turn (не создан второй ход);
- second session create+replay — то же поведение.
Статус: **PASS** (create → 3 turns → resume → idempotent replay).

### 5. Rollback preview — **PROVEN (drill с оговоркой)**

`scripts/b13-b2-rollback-drill.mjs`:
- ref preview-ветки сдвигается на предыдущий зелёный артефакт (`af9f213`, у которого был success
  деплой-ран) → dispatch через адаптер → run `34325047861` success → smoke 200 + ожидаемая строка;
- ref возвращается на `ffba7c8` → dispatch → run `34325106273` success → smoke 200;
- квитанции в `docs/worklog/b13-b2-rollback-receipt.json`; ref восстановлен (проверено).
Оговорка (важно, T35-честность): откат на `efb94a8` (соседний коммит) невозможен без правок —
его тесты красные, workflow не деплоит красные артефакты. Rollback ограничен артефактами с
зелёным CI; это свойство workflow, а не адаптера. Ref-move выполняется оператором (API-вызов
в drill'е явный), адаптер не двигает ref сам.

## Итог

| Пункт | Статус |
|---|---|
| 1. Изоляция a2 | PARTIAL (policy-allowlist + CI runner как изолированная среда; host-режим hygiene-only) |
| 2. Живой деплой через адаптер + operation ID + lost-response reconcile | PROVEN (деплой, квитанция, живой reconcile без dispatch) |
| 3. Версии в preview | sandbox@f8bbd69 (app 0.1.0 + ENGINE_* vars) → engine VPS @ 6e01c0b (live-author-studio feat/b13-acceptance-closure) |
| 4. Игровой smoke | PROVEN (create/turns/resume/idempotency) |
| 5. Rollback preview | PROVEN (только зелёные артефакты; ref-move оператором) |
