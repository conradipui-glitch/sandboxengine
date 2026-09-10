# 2026-09-11 — M06: независимая проверка и корректирующие работы R01–R03

Карточка: корректирующее задание по итогам независимого аудита M06. Предыдущий отчёт о завершении M06 отозван: hosted happy-path подтверждён, полная приёмка — нет.

## Среда

- Node `24.19.0`, npm `11.9.0` (system Node 22 даёт ложные падения).
- Engine: `feat/b13-acceptance-closure`, вход в этап `230b39c`.
- Site: `feat/florence-vertical-slice`, вход в этап `c60442112923ff09bc255afbaca9d0659da77e69`.
- VPS проверялся read-only; в этом этапе ничего не доставлялось и не перезапускалось.

## R01 — immutable release + согласованная публикация (F01/F02/F03), commit `5475da0`

Сначала регрессионные тесты, показывающие дефекты: `apps/server/test/m06-immutable-release.test.mjs` — 0/4 pass (RED).

Наблюдаемое до исправления (реальные HTTP-ответы):

- F01: publish v1 → create 201 → GET 200 → save draft revision 2 → GET существующей сессии `409 PUBLIC_MISSION_RELEASE_STALE`, создание новой игры `409`;
- F02: publish release-2 после редактирования → `409 PUBLICATION_SOURCE_STALE`; повтор с `expectedCurrentReleaseId=release-1` → `409 CURRENT_RELEASE_CONFLICT, currentReleaseId=release-2` (отказ уже изменил состояние);
- F03: unpublish → GET с корректным credential → `404`.

Исправление:

- добавлен `getMissionAtRevision` в `MissionDocumentStore` (+SQLite) — резолв неизменяемой авторской ревизии;
- публичный маршрут разделён: новая игра требует активной публикации и создаётся с явным `contentRevision` pin; продолжение игры пинится на `session.contentRevision` и публикации не требует;
- `syncPublicationRecord` перекрепляет каталог на опубликованную ревизию (stable id/slug сохраняются), `contentHash` каталога — bundle-identity (renderer contract + авторский contentHash + дайджесты используемых ассетов), quest-board compile hash больше не выдаётся за идентичность MissionDraft;
- каталог пишется до release pointer; при отказе promotion — компенсирующий откат каталога.

Проверка после исправления: `node --test apps/server/test/m06-immutable-release.test.mjs` — 4/4 pass. Сценарии: правка черновика не ломает открытую сессию и новые игры v1; publish v2 проходит, новые игры на v2, сессия A остаётся на v1; отказ записи каталога не двигает указатель; unpublish блокирует только новые запуски, turn уже начатой игры → 200, без credential → 401.

## R02 — состояние игры и retry (F04), site commit `f7f1233`

Дефект: движок при финале оставляет предыдущий `currentSceneId` и пишет финал в `world.terminal`; BFF использовал временный `target` и не сохранял терминал, поэтому reload отдавал обычную сцену и `status: active`.

Тесты: `src/worker/public-mission-recovery.test.ts` — 3/3 (RED до правки: reload отдавал `start` вместо `ending:done`), плюс route-level сценарий `b11-public-route.test.ts` «keeps the finale when the player reloads the page».

Исправление: канонический терминал хранится в binding; `viewFor` строит финал из него; добавлен `reconcilePublishedMissionSession` (GET к движку), GET-маршрут в worker'е реконсилируется и перезаписывает binding при расхождении; повтор после потерянного ответа идёт с тем же idempotency key и тем же `baseTurn`, без второго применения эффекта.

## R03 — реальный сайт по авторским данным (F05/F06), engine `8ebe741`, site `db7cbe8`

- `src/shared/mission-presentation/frame-build.ts` + тест 5/5: frame строится только из авторского документа (story + screens + defaults), без сценарийных ID и без fallback-арта; неизвестная сцена/финал → `null`.
- Контракт игры получил дискриминатор `presentation.kind = "published-mission"` с frame; `src/client/PublishedMissionStage.tsx` рендерит `MissionSceneStage`/`MissionChoicePanel`/`MissionEndingScreen` (тест 4/4: авторские фон, слои, варианты, финал); `Game` в `App.tsx` уходит в этот путь до legacy-расчётов, поэтому кабинет/министр/Florence-ассеты к опубликованной миссии не применяются.
- F06: неизвестная `mission:`-ссылка → `404 PUBLIC_MISSION_NOT_FOUND` (не legacy); сбой каталога → 5xx (не скрытый fallback); `/api/scenarios` объединяет published и legacy-карточки с дедупликацией.
- Engine: публичные ассеты pinned-ревизии — `GET /public/v1/missions/:id/assets/:assetId`, только для опубликованной ревизии и только для ассетов, которые она упоминает; unpublish отзывает. Тест `apps/server/test/m06-public-asset.test.mjs` 1/1.

## Регрессия (Node 24.19.0)

Все прогоны — Node `24.19.0` (portable, `%TEMP%
ode-v24.19.0-win-x64`), npm `11.17.0`. Hermes-овский Node `v22.23.2` даёт ложное падение `C17` (проверка `process.version`), поэтому для отчёта он не использовался.

| Проверка | Команда | Результат |
|---|---|---|
| Engine typecheck/build | `npm run build` | exit 0 |
| Control | `npm run test:control` | 106/106, fail 0 |
| Server | `npm run test:server` | 133/133, fail 0 |
| Contracts | `npm run test:contracts` | 57/57, fail 0 |
| Studio | `npm run test:studio` | 111 pass, 0 fail, 1 skip (C18 требует `CORRECTION_VPS_URL`) |
| M06 focused (engine) | `node --test m06-immutable-release / m06-public-asset / m06-publish-sync / m06-public-runtime / m06-public-catalog` | 4 + 1 + 3, fail 0 |
| Site typecheck | `npm run check` | exit 0 |
| Site tests | `npx vitest run` | 18 файлов, 82/82, fail 0 |
| Site build | `npm run build` | exit 0 |

## R04 — воспроизводимое размещение (F07), commit `83f5cbf` — ДОСТАВЛЕНО И ПРОВЕРЕНО HOSTED

Live lifecycle выполнен 2026-09-11 (санкция владельца получена, «всё по плану»).

- `deploy/vps/docker-compose.yml`: добавлен сервис `authored` (`lhc-authored`) с `restart: unless-stopped`, `working_dir: /engine`, `command: node /engine/deploy/vps/authored-server.mjs`, собственным healthcheck на `127.0.0.1:8746/healthz` и общим томом `engine-data`. Раньше runtime :8746 запускался вручную через `docker exec -d`, поэтому пересоздание `lhc-engine` его теряло (nginx начинал отдавать 502).
- `engine` получает `LH_PUBLIC_MISSION_SESSION_SECRET` из `deploy/vps/.env` через `--env-file` вместо `/tmp/lhc-m06-compose-override.yml` (файл 0644 в `/tmp`, не переживал перезагрузку и был читаем локальным пользователям).
- `deploy/vps/authored-server.mjs`: `MemoryPublishedSessionBindingStore` → `SQLitePublishedSessionBindingStore` (+ закрытие на shutdown), поэтому перезапуск контейнера больше не теряет начатую legacy authored-сессию. Долговечность этого стора уже покрыта `apps/server/test/published-runtime-restart.test.mjs`.
- `docs/RUNBOOK.md` §15: состав сервисов, где лежит конфигурация, процедура восстановления после пересоздания контейнера и план отката.

Проверка кандидата: `docker-compose.yml` разобран парсером — 4 сервиса, команда и healthcheck `authored` на месте, интерполяция секрета присутствует; полный lifecycle (`compose up` с нуля, restart, reload) требует VPS и не выполнялся.

## Доставка exact-SHA и hosted-подтверждение (2026-09-11)

Доставка выполнена скриптом, а не руками: `/root/m06-r04-delivery.sh` (fail-closed по полному SHA) и подготовленный `/root/m06-r04-rollback.sh` (не выполнялся — откат не потребовался).

| Шаг | Команда/факт | Результат |
|---|---|---|
| Fast-forward | `git fetch` + `git reset --hard 7e61f98…` (ancestor-проверка `b1546da` → `7e61f98`) | VPS HEAD = `7e61f9889724f01a5f5c1c2e511093c177ceac6b`, worktree чист |
| Секрет | `deploy/vps/.env` (0600, ровно 1 запись, значение [REDACTED]) | `/tmp/lhc-m06-compose-override.yml` удалён |
| Сборка | `docker compose build engine authored` | exit 0 |
| Подъём | `docker compose up -d --no-deps --force-recreate engine authored` | `lhc-engine` healthy, `lhc-authored` healthy (новый контейнер) |
| Порты | `ss -ltnp` | 8742+8788 → контейнер engine, 8746 → контейнер authored (ручного процесса больше нет) |
| Надзор | `docker restart lhc-authored` | снова healthy; создание публичной сессии после рестарта — 201 |
| Site | workflow run `34536157061` на `db7cbe8` | completed/success |

Live-приёмка через реальный HTTPS и site BFF (`living-history-florence-preview.conradipui.workers.dev`):

1. `GET /public/v1/missions` → 200 с опубликованной миссией; detail по slug/id → 200.
2. `POST /api/games` опубликованной миссии → **201** (до исправления: `MISSION_SESSION_CREATE_FAILED` / `CONTROL_INTERNAL_ERROR` из-за `INVALID_RELEASE`); в ответе `presentation.kind = "published-mission"` и кадр авторской сцены («Палатка лагеря», `contentRevision 1`, `contentHash b05ba76…`).
3. Ход 1 → «Бастион» (turn 1); ход 2 → финал «Отчёт написан», `status: victory` (turn 2).
4. `GET /api/games/:id` после финала → `frame.kind = ending`, финал сохранён (F04 live).
5. `POST /api/games` с неизвестным `mission:`-ref → **404 `PUBLIC_MISSION_NOT_FOUND`**, без отката в legacy (F06 live).
6. `GET /api/scenarios` → 6 карточек: опубликованная миссия **плюс** 5 legacy (аддитивность, F06 live).
7. Legacy-путь (без published-ссылки) по-прежнему отдаёт исторический сценарий `russia-1917` — регрессии нет.

Не подтверждено live (честно):

- F01/F03 в живом сценарии «правка черновика / unpublish при открытой сессии» — требует owner-сессии Control; сессия не создавалась, чужие cookies не использовались, поэтому проверка остаётся на уровне integration-теста `m06-immutable-release.test.mjs` 4/4;
- браузерный проход глазами игрока (проверялось HTTP/BFF-уровнем, не UI);
- C18 editor/viewer/read-only — нужны отдельные Telegram-аккаунты;
- rollback-скрипт синтаксически проверен, но не исполнялся.

## Открыто

- **M06 — PARTIAL**: локальная регрессия зелёная, исправления доставлены и hosted happy-path подтверждён; полная приёмка (F01/F03 live, браузер, C18, повторный независимый прогон) не закрыта.
- Повторный независимый аудит по новым SHA (`7e61f98` engine / `db7cbe8` site) — не выполнялся.
- C18 editor/viewer/read-only — нужны отдельные Telegram-аккаунты; локальные серверные проверки разрешений не подменяют живой вход.
