# FIN-01 — неизменяемый bundle релиза и настоящий rollback (B02; M01/M06)

Дата: 2026-09-11. Репозиторий: engine `C:/Users/kato55/Documents/Codex/2026-09-09-live-author-studio` (`feat/b13-acceptance-closure`), вход `97810ea`.
Runtime проверок: portable Node `24.19.0`, npm `11.17.0` (`AppData/Local/Temp/node-v24.19.0-win-x64`).

## Дефект (подтверждён чтением кода и тестом)

`syncPublicationRecord` (`apps/server/src/control-server.ts`) резолвил публикуемый контент через `missionStore.getMission(projectId, questId)` — **latest MissionDraft**, а не ревизию, привязанную к релизу. Следствия:

- rollback r2 → r1 возвращал в публичном указателе `releaseId=r1`, но каталог перекреплял `draftRevision`/`draftContentHash` на текущий (уже r2/v2) draft → новый игрок получал сюжет, не соответствующий заявленному релизу;
- повторная публикация существующего релиза могла «переехать» на более новый draft;
- отсутствующие материалы попадали в `missionBundleHash` как молчаливый `null`.

Релиз (`ControlReleaseRecord`) хранит pin **совета** (`draftRevision`/`draftContentHash` — board draft), но не pin авторизованной миссии; постоянной привязки `releaseId → bundle` не существовало.

## Изменения

- `packages/control/src/publication-store.ts` — новый неизменяемый pin `releaseId → bundle`:
  - тип `ControlPublicationReleasePin` (`releaseId`, `missionRevision`, `missionContentHash`, `assets[{assetId,hash}]`, `assetsVerified`, `pinnedAtMs`);
  - методы `getReleasePin` / `pinRelease` в `ControlPublicationStore`, реализованы в `MemoryControlPublicationStore` и `SQLiteControlPublicationStore`;
  - SQLite: таблицы `control_publication_release_pins` (PK `project_id, quest_id, release_id`) и `control_publication_pin_idempotency`; повтор с тем же ключом и другим запросом → `pin_conflict`, тот же запрос → `replay`;
  - pin неизменяем: существующий releaseId не может сменить ни ревизию, ни manifest.
- `apps/server/src/control-server.ts`:
  - `resolveReleaseBundle(releases, missionStore, projectId, questId, releaseId, existing, mode)` — единственная точка материализации bundle: pin → `getMissionAtRevision(pinnedRevision)` + сверка `contentHash`; отсутствие pin при `mode="publish"` → pin текущей авторизованной ревизии; при `mode="rollback"` → отказ `LEGACY_PIN_UNPROVABLE`;
  - legacy-переход: если записи публикации ещё нет, но привязка доказуема записью (`existing.releaseId === releaseId` и ревизия из записи резолвится с тем же hash), pin берётся **из записи**, а не из latest draft; иначе — отказ;
  - manifest материалов: при `assetsVerified` каждый asset из pin должен присутствовать в библиотеке проекта с тем же hash, иначе `ASSET_MISSING` / `ASSET_CHANGED`;
  - `syncPublicationRecord` использует только резолвнутый bundle (`releaseId` + `missionRevision` + `bundleHash`), плюс `preResolved` для rollback;
  - маршрут build публикации (`POST …/releases`) фиксирует pin в момент сборки (freeze до публикации), best-effort;
  - маршрут rollback: preflight bundle **до** сдвига указателя — rollback, который не может доказать свой контент, не отрывает каталог от текущего релиза; ошибка → `409 PUBLICATION_BUNDLE_UNAVAILABLE` + `detailCode`.
- `apps/server/test/fin01-release-bundle.test.mjs` — 5 новых тестов (независимый контракт, не private helper).

## Проверка

| Команда | Результат |
|---|---|
| `git stash push -- apps/server/src/control-server.ts` + `node --test apps/server/test/fin01-release-bundle.test.mjs` (до фикса) | **0/5**, ключевое падение: «the catalog must point at the revision release r1 published — `2 !== 1`» (B02) |
| `npm run typecheck` | exit 0 |
| `node --test apps/server/test/fin01-release-bundle.test.mjs` (после фикса) | **5/5** |
| `npm run test:control` | **106/106** |
| `npm run test:server` | **138/138** (было 133, +5 FIN-01) |

Покрытые сценарии теста: rollback r2→r1 отдаёт контент r1 (текст, `contentRevision`, `contentHash`); повторная публикация старого релиза не подхватывает новый draft; pin переживает reopen SQLite-базы; изменённые байты материала (тот же assetId, другой hash) блокируют публикацию релиза с понятной ошибкой; legacy-запись публикации даёт прежнюю ревизию вместо latest draft; rollback на релиз с недоказуемой ревизией → `409 PUBLICATION_BUNDLE_UNAVAILABLE` / `LEGACY_PIN_UNPROVABLE` и указатель релиза не сдвигается.

## Не проверено / ограничения

- Hosted-проверка (VPS) не выполнялась: правка не доставлялась на стенд. Требуется карточкой FIN-04 вместе с manifest версий процессов.
- Bundle фиксируется при сборке релиза через HTTP-маршрут; релизы, собранные до этой правки, pin не имеют — их соответствие берётся из записи публикации, а при недоказуемости публикация/rollback отказывают (это ожидаемое поведение, не регрессия).
- `initialWorld` клиента по-прежнему заполняет BFF сайта (`public-mission-bff.ts`); чтение начального состояния строго из релиза и запрет подмены — отдельная проверка FIN-01/E11, выполняется вместе с FIN-02/FIN-03.
