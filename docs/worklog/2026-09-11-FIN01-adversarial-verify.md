# FIN-01/B02 — состязательная проверка «неизменяемый pin releaseId→bundle»

Дата: 2026-09-11. Worktree: `C:/Temp/lhc-fin01-verify`, ветка `feat/fin01-adversarial-verify`, HEAD `1886041`.
Runtime: portable Node `24.19.0` (`C:/Users/kato55/AppData/Local/Temp/node-v24.19.0-win-x64`), npm `11.17.0`.
Сборка: `npm ci` один раз, затем `npm run typecheck` (tsc -b, exit 0) — тесты грузят `apps/server/dist/*.js`.

## Вердикт

**Фикс держит контур управления (publish/rollback по пину), но НЕ держит публичный контур отдачи.** Найдены три живых сценария, в которых каталог/сессия отдают контент, не совпадающий с заявленным (запиненным) бандлом. Ни один из них не является регрессией, внесённой `1886041`: публичные маршруты отдачи и «best-effort» семантика freeze при сборке не менялись (проверено `git diff -U0 HEAD~1 HEAD -- apps/server/src/control-server.ts` — изменены только маршруты build/publish/rollback и `syncPublicationRecord`/`resolveReleaseBundle`). Но каждый из них противоречит гарантии из сообщения коммита.

### Контрпример 1 (каталог+сессия отдают не ту ревизию) — главный

Freeze при сборке релиза (`apps/server/src/control-server.ts:870`) — best-effort и глушит ошибку: `await resolveReleaseBundle(...).catch(() => undefined)`. Если на момент сборки у миссии отсутствует хотя бы один материал, pin не пишется, а клиент всё равно получает `201 Created` без признака «не заморожен». Дальше публикация этого релиза уходит в ветку первого publish и пинит **текущую** (уже другую) авторизованную ревизию.

Наблюдаемое (HTTP, без моков):

| Шаг | Результат |
|---|---|
| `saveMission("Ночь.", base 0)` при отсутствующем `late-bg` | миссия ревизии 1 |
| `POST .../releases {release-1, draftRevision 0}` (через маршрут) | `201`, `getReleasePin(...) === null` |
| загрузить `late-bg`, `saveMission("Поздняя ночь.")` | миссия ревизии 2 |
| `POST .../publish {release-1}` | `200`; каталог `draftRevision = 2`, сессия отдаёт «Поздняя ночь.» |

То есть релиз, собранный при ревизии 1, публикуется и отдаётся как ревизия 2 — ровно тот класс дефекта, который B02 заявляет закрытым («publish ... резолвят контент через pin, а не через latest draft»).

### Контрпример 2 (ассет, изменённый после пина, отдаётся молча — сценарий (d))

Проверка манифеста живёт только в `resolveReleaseBundle`, т.е. на publish/rollback. Публичные маршруты (`routePublicMissionSession`, `routePublicMissionAsset`) её не вызывают. После подмены байтов ассета:

- `POST .../publish {release-1}` → `409 PUBLICATION_BUNDLE_UNAVAILABLE / ASSET_CHANGED` (fail loud — верно);
- `POST /public/v1/missions/cargo/sessions` → **`201`**, новая сессия у проблемного релиза создаётся;
- `GET /public/v1/missions/cargo/assets/<id>` → **`200`** и байты с хэшем, которого нет в пине (`sha256(bytes) = 3ce0213… ≠ pinned f8879af…`), при этом каталог продолжает рекламировать запиненный `contentHash`.

Гарантия «ассеты проверяются по запиненному манифесту, а не молчаливый null» на публичном контуре не выполняется: подмена отдаётся тихо.

### Контрпример 3 (legacy-pin обходит проверку манифеста — сценарии (a)+(d))

Пин, выведенный из дофиксовой записи, помечается `assetsVerified: false`, и блок сверки манифеста для него пропускается (`if (pin.assetsVerified) { ... }`). На смоделированной дофиксовой БД (запись есть, таблица пинов пуста):

- `POST .../rollback {release-1}` при уже подменённом ассете → **`200`** (тихо), `assetsVerified: false`, `assets: []`;
- тот же `releaseId` после этого рекламирует **другой** `contentHash` бандла (`02bc056… ≠ 1d210b1…`), т.е. нарушается инвариант, который проверяет собственный тест фикса («the same release must resolve to the same bundle hash»).

## Что фикс держит (доказательно зелёное)

- rollback r2→r1 отдаёт ревизию и hash релиза r1, не latest draft; обратный rollback возвращает r2 (`fin01-verify-session-revisions.test.mjs`).
- Сессии, открытые до и после rollback, сохраняют каждая свою ревизию — проверено и через `/turns`, а не только чтением (там же).
- Повторная публикация существующего релиза не «переезжает» на новый draft; второй ключ идемпотентности не перезаписывает пин (тавтологичности нет: сверяется весь объект пина).
- Ключ публикации, переиспользованный для другого релиза, отклоняется (`409 IDEMPOTENCY_KEY_REUSED`/`PUBLICATION_CONFLICT`), указатель релиза и каталог не сдвигаются.
- Пин переживает переоткрытие SQLite (тест фикса) — воспроизведено в его составе.
- Публичный rollback на релиз без пина и без доказуемой записи → `409 LEGACY_PIN_UNPROVABLE`, указатель не двигается (тест фикса).

## Файлы

| Файл | Тип | Что фиксирует |
|---|---|---|
| `apps/server/test/fin01-verify-support.mjs` | harness (без `.test.`) | Общая обвязка на реальных `SQLiteControlStore`/`SQLiteControlPublicationStore`/`createControlHttpServer`, без моков |
| `apps/server/test/fin01-verify-public-asset-drift.test.mjs` | зелёный (2 теста) | Контрпример 2: подменённый ассет отдаётся новой сессии и по asset-маршруту |
| `apps/server/test/fin01-verify-legacy-bundle.test.mjs` | зелёный (1 тест) | Контрпример 3 на Memory-сторе + контраст с запиненным релизом |
| `apps/server/test/fin01-verify-build-freeze.test.mjs` | зелёный (2 теста) | Контрпример 1: freeze при сборке провалился молча |
| `apps/server/test/fin01-verify-session-revisions.test.mjs` | зелёный (2 теста) | Сценарии (b)/(f): ревизии сессий и каталога вокруг rollback |
| `apps/server/test/fin01-verify-idempotency.test.mjs` | зелёный (3 теста) | Сценарий (e) |
| `apps/server/test/fin01-verify-sqlite-parity.test.mjs` | зелёный (3 теста) | Контрпримеры 1–3 на `SQLiteControlPublicationStore`, включая дофиксовую БД |
| `apps/server/test/fin01-verify-defect-contract.mjs` | **красный, намеренно** (4 теста) | Контракт, который заявляет B02; падает на `1886041` |

`fin01-verify-defect-contract.mjs` сознательно не оканчивается на `.test.mjs`, чтобы `npm run test:server` оставался зелёным; запускать явно (см. ниже).

## Команды и результаты

| Команда | Exit | Результат |
|---|---|---|
| `npm ci` | 0 | зависимости |
| `npm run typecheck` | 0 | `dist/` собран |
| `node --test apps/server/test/fin01-release-bundle.test.mjs` | 0 | 5/5 pass (регрессий в тестах фикса нет) |
| `node --test apps/server/test/fin01-verify-*.test.mjs` | 0 | **13/13 pass** (характеризующие тесты фактического поведения) |
| `node --test apps/server/test/fin01-verify-defect-contract.mjs` | **1** | **4/4 fail** — контрпримеры живы; см. дословный вывод ниже |
| `npm run test:server` | 0 | 151/151 pass (138 до фикса + 13 новых; файлы без `.test.` в глоб не попадают) |

Дословный вывод красного файла (сокращены только пути стека):

```
✖ CONTRACT: after the pin exists, the public catalog must serve the pinned asset bytes or fail loudly
  AssertionError: the public asset endpoint served bytes that are not in the pinned manifest
  + '3ce021382ff6158628330a5676091f13cd82c23f147d1fe90b5ec747e22c95d7'
  - 'f8879aff94e9eac70b34dfc750f97fdbb672cdd08ccf0e6ddbf61b350ab756c0'
✖ CONTRACT: a session must not be created for a release whose pinned bundle can no longer be reproduced
  AssertionError: a new player was created for a release whose pinned bundle is provably broken
  201 !== 201
✖ CONTRACT: a release must publish the authored revision that was current when it was built
  AssertionError: publish resolved the newest draft instead of the revision the release was built from
  2 !== 1
✖ CONTRACT: the same releaseId must always resolve to the same bundle hash
  AssertionError: the same releaseId now advertises a different bundle hash than it published
  + '02bc05697ee1a3672bb9f25195292998099e293e27e5e90cb1d8744b2f47b7be'
  - '1d210b100fbd90a17d1746de414c703dc3f6edc85eb59e4528517a64bf54473d'
ℹ tests 4  ℹ pass 0  ℹ fail 4
exit 1
```

## Чего я НЕ смог проверить

- **Живой стенд (VPS)**: ничего не деплоил; hosted-путь, nginx и реальный BFF `public-mission-bff.ts` не проверялись. Заголовок `cache-control: public, max-age=31536000, immutable` на байтах ассета означает, что корректный фикс на сервере всё равно может отдавать старые байты через кэш — это отдельный риск (FIN-04).
- **Гонки**: одновременные publish/rollback (пин и сдвиг указателя не в одной транзакции на уровне двух разных хранилищ) не моделировал.
- **Настоящая миграция дофиксовой БД на стенде**: дофиксовое состояние симулировал удалением строк из таблиц пинов в локальном SQLite (`fin01-verify-sqlite-parity.test.mjs`), а не реальным апгрейдом.
- **Auth-режим**: harness работает в local-режиме без `auth`; роли/мутация-proof не проверялись.
- **Удаление ассета**: API удаления нет, достижима только замена байтов по тому же `assetId`.
- **`initialWorld`-подмена** (упомянута как отдельная FIN-01/E11) не входила в задачу.
