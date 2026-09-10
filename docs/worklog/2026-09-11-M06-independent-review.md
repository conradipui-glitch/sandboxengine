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

## R04 — воспроизводимое размещение (F07), commit `83f5cbf`

Кандидат подготовлен, live-рестарт не выполнялся.

- `deploy/vps/docker-compose.yml`: добавлен сервис `authored` (`lhc-authored`) с `restart: unless-stopped`, `working_dir: /engine`, `command: node /engine/deploy/vps/authored-server.mjs`, собственным healthcheck на `127.0.0.1:8746/healthz` и общим томом `engine-data`. Раньше runtime :8746 запускался вручную через `docker exec -d`, поэтому пересоздание `lhc-engine` его теряло (nginx начинал отдавать 502).
- `engine` получает `LH_PUBLIC_MISSION_SESSION_SECRET` из `deploy/vps/.env` через `--env-file` вместо `/tmp/lhc-m06-compose-override.yml` (файл 0644 в `/tmp`, не переживал перезагрузку и был читаем локальным пользователям).
- `deploy/vps/authored-server.mjs`: `MemoryPublishedSessionBindingStore` → `SQLitePublishedSessionBindingStore` (+ закрытие на shutdown), поэтому перезапуск контейнера больше не теряет начатую legacy authored-сессию. Долговечность этого стора уже покрыта `apps/server/test/published-runtime-restart.test.mjs`.
- `docs/RUNBOOK.md` §15: состав сервисов, где лежит конфигурация, процедура восстановления после пересоздания контейнера и план отката.

Проверка кандидата: `docker-compose.yml` разобран парсером — 4 сервиса, команда и healthcheck `authored` на месте, интерполяция секрета присутствует; полный lifecycle (`compose up` с нуля, restart, reload) требует VPS и не выполнялся.

## Открыто

- **F07/R04** — кандидат готов (см. выше), но live lifecycle не прогонялся: сервис `authored` не поднимался на VPS, `compose up` с нуля, restart и reload на стенде не проверялись. Секрет всё ещё существует в `/tmp/lhc-m06-compose-override.yml` до доставки нового compose и переноса значения в `deploy/vps/.env`.
- Повторная exact-SHA доставка engine/site и live-приёмка (два браузерных прохода, unpublish, каталог) — не выполнялись.
- C18 editor/viewer/read-only — нужны отдельные Telegram-аккаунты; локальные серверные проверки разрешений не подменяют живой вход.
- M06 — **PARTIAL**, не завершён.
