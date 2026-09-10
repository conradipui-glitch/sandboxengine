# 2026-09-10 — Studio V00–V02 correction K00–K08

Статус: **IN_PROGRESS**

## K00 — входная сверка

- Репозиторий: `conradipui-glitch/sandboxengine` / локальная копия `C:/Users/kato55/Documents/Codex/2026-09-09-live-author-studio`.
- Ветка: `feat/b13-acceptance-closure`.
- Входной SHA: `bc8313d31bca1fb0526e4b18a31d3ddd5bdbf7d9`.
- Рабочее дерево на входе: clean.
- Совместимый runtime: `npx --yes node@24.19.0` → `v24.19.0`; `npx --yes -p npm@11.9.0 npm --version` → `11.9.0`. Требование `package.json` `>=24.19.0 <25` не изменялось.
- Локальные `STUDIO-V00-V02-REVIEW-RU.md` и `STUDIO-VISUAL-EDITOR-SPEC-RU.md` в checkout не найдены. Каноническим основанием этой карточки является переданное пользователем ТЗ; `docs/SPECIFICATION.md` прочитан по разделам, относящимся к авторскому циклу, API, проверкам и ограничениям.
- Существующие проекты Florence и «Приёмка VPS» не используются для демонстрационных изменений.
- Авторизация `@living_history_gate_bot` не меняется.
- V00 namespaces `/studio-assets/*` и `/player-assets/*` сохраняются.

## K01 — единый renderer и lifecycle — DONE

- Активный renderer: `apps/studio/src/board-dom.ts` через `mountBoard`.
- `apps/studio/src/board-render.ts` удалён после проверки импортов и полного Studio suite.
- `apps/studio/src/board-lifecycle.ts` держит один handle на project/quest и предоставляет update, selection, viewport get/set, fit, destroy.
- `app.ts` сохраняет host/handle между shell renders: вкладка inspector, save/validation и status не перемонтируют canvas и не вызывают fit.
- На выходе из проекта/квеста/logout вызывается destroy; root listeners также снимаются публичным `StudioApp.destroy()`.
- Callback wrappers получают generation token; async draft save проверяет project/quest context после ответа и не применяет stale result к новому квесту.

Проверено:
- K01 RED: `node@24.19.0 --test apps/studio/test/board-lifecycle.test.mjs` → отсутствовал `dist/src/board-lifecycle.js`.
- K01 GREEN: тот же suite → **2/2 passed**.
- `npm run typecheck` через Node 24.19.0 → exit 0.
- `node@24.19.0 --test apps/studio/test/*.test.mjs` → **78/78 passed**.

Ограничение, перенесённое в K02/K04: layout пока localStorage, а inspector и серверный BoardDocument ещё не реализованы.


| R | Проверка на входе | Статус | Фактическое основание |
|---|---|---|---|
| R01 | Один renderer и lifecycle mount/update/selection/viewport/destroy | **DONE локально** | `app.ts` uses `mountBoard`/`BoardLifecycle`; `board-render.ts` removed after import/test check; browser lifecycle evidence remains in C09. |
| R02 | Доска — главный экран, рабочие размеры и рабочие кнопки | **DONE локально + BROWSER/LOCAL** | K02 viewport shell, board-main workspace, utility menu and one board/list toggle are implemented; local browser smoke confirms board remains mounted while utility panels open. |
| R03 | Настоящий inspector выбранного canonical block | **DONE локально + BROWSER/LOCAL** | `block-inspector.ts` + app inspector, полный `block.replace`, debounce и conflict preservation проверены browser smoke. |
| R04 | Создание и редактирование четырёх типов блока | **DONE локально + BROWSER/LOCAL** | Library/modal создали location, character, resource и action; type-specific canonical fields подтверждены GET draft. |
| R05 | Связи, drag/zoom/fit, collision-aware layout | **DONE локально + BROWSER/LOCAL** | `edgeToDraftChange` используется app; SVG edges имеют direction marker; valid/invalid pointer connections, два drag с edge tracking, zoom/pan/fit и collision-free fallback проверены. |
| R06 | Серверный versioned BoardDocument, CAS/idempotency/restart/other browser | **DONE локально + BROWSER/LOCAL** | SQLite BoardDocument/idempotency tables, v1→v2 migration, atomic bounds/CAS, GET/POST route, generated registry/OpenAPI, close/reopen and profile A→B readback verified. VPS remains open. |
| R07 | Read-only/role behavior and V00/Player regression evidence | **DONE локально + VPS unauthenticated** | K06 authenticated role/CSRF/revoke test, local Studio/Player/launch suites, and public VPS asset/auth matrix verified; logged-in Telegram browser playtest remains unavailable without user session. |
| R08 | Regression suite C01–C18 and real connected renderer | **PARTIAL — C18 authenticated browser OPEN** | Added `apps/studio/test/correction-acceptance.test.mjs`: C01–C17 pass; C18 boundary passes after exact deploy, but authenticated Telegram browser proof is unavailable. Browser/CDP evidence is linked in `docs/acceptance/studio-c01-c18.md`; full verify passed after registry-count fix. |
| R09 | Hosted identity and server-side global provider/project permissions | **DONE локально** | Authenticated Board GET/POST uses session identity and live project role; forged identity headers fail; revoked session returns 401; local provider mutation rejects non-loopback Host and cross-site Origin before body handling. VPS smoke remains open. |

## Evidence at K00

- `node --version` from default shell: `v22.23.2` (incompatible; not used for acceptance).
- `npx --yes node@24.19.0 --version`: exit 0, `v24.19.0`.
- `npx --yes -p node@24.19.0 -p npm@11.9.0 -c "node --version && npm --version"`: exit 0, `v24.19.0`, `11.9.0`.
- `git branch --show-current`: exit 0, `feat/b13-acceptance-closure`.
- `git rev-parse HEAD`: exit 0, `bc8313d31bca1fb0526e4b18a31d3ddd5bdbf7d9`.
- `git status --short`: exit 0, empty.
- Review files named in the task: not present locally; no claim of having read them.

## Следующая точная операция

K01: добавить failing lifecycle regression against the actually mounted board, switch `app.ts` to one `mountBoard` handle with generation/project guards, then verify focused board tests before K02.

## C01–C18 preliminary status

Все C01–C18: **OPEN** на входе; existing model tests are not counted as acceptance evidence.

## K02 — доска как главный экран — DONE

- `.ed-shell` занимает viewport; библиотека `240px`, inspector `336px`, центральная область и внутренние панели прокручиваются отдельно.
- Validation перенесена внутрь центральной области; `ed-bottom` и основной поток versions/portability убраны.
- Меню `…` открывает «История версий», «Импорт и экспорт», «Настройки проекта и доступа».
- Inspector по умолчанию — «Свойства карточки» с подсказкой «Выберите карточку на доске»; доступ и ID перенесены в настройки.
- Вкладка помощника подписана «ИИ-помощник»; видимый переключатель один: «Доска / Список».
- Добавлена единая primary/secondary button system и responsive CSS с доступным inspector на 360px.
- STATIC: Node 24.19.0 `npm run typecheck` exit 0; Studio suite `78/78`.
- BROWSER/LOCAL: отдельная SQLite и чистый Chrome с CDP; через реальный DOM click создан throwaway project/quest. После открытия квеста `data-board-host=true`; меню, History и Portability открылись, доска оставалась в DOM.

### R status after K02

- R01 **DONE локально** (K01; browser lifecycle C09 ещё открыт).
- R02 **DONE локально + BROWSER/LOCAL**, VPS для candidate ещё не обновлён.
- R03/R04/R05/R06/R08/R09 **OPEN**; R07 **PARTIAL**.

## K03 — canonical inspector и четыре типа — DONE локально + BROWSER/LOCAL

- Добавлен `apps/studio/src/block-inspector.ts`: `createBlockForKind` строит только canonical `location/character/resource/action`, `replaceBlockWithPatch` выпускает полный `block.replace`; исходные `description` и неизменённые `data`-поля сохраняются, `block.update` не используется.
- Библиотека редактора получила создание всех четырёх типов. Для action форма требует существующий resource и не создаёт dangling reference; character поддерживает `initialLocationId`/`initialStatus`, resource — unit/range/value, action — resource/cost/duration/allowPartial.
- Inspector выбранного узла редактирует canonical title/description и type-specific data; ввод хранится локально до ответа сервера, debounce — 700 ms, есть явное «Сохранить карточку», read-only поля отключаются по access state.
- Добавлен lifecycle focus после создания и отдельное сохранение inspector без перемонтирования доски.

Проверено:
- RED: `node@24.19.0 --test apps/studio/test/block-inspector.test.mjs` → отсутствовал `dist/src/block-inspector.js`.
- GREEN: тот же тест после сборки → **3/3 passed**.
- `npm run typecheck` через Node 24.19.0 → exit 0; Studio suite после K03 → **81/81 passed**.
- BROWSER/LOCAL на `http://127.0.0.1:4184` с отдельной SQLite: реальный Chromium/CDP создал location, character, resource и action; после открытия квеста все пять узлов (включая start) видны на доске.
- BROWSER/LOCAL inspector изменил title/description resource/action; Control GET подтвердил server draft revision `5` и canonical data.
- BROWSER/LOCAL conflict: внешний `block.replace` поднял revision `5→6`; локальный inspector получил «Ничего не перезаписано», локальное имя осталось в поле, GET подтвердил серверную внешнюю description без overwrite.
- BROWSER/LOCAL переключение «Свойства → ИИ-помощник → Свойства» не потеряло сохранённое содержимое и доску.

Ограничения: это доказательство локального браузера и Control persistence; серверный BoardDocument/restart/другой браузер ещё относятся к K05, live VPS candidate не обновлялся.

### R status after K03

- R01 **DONE локально** (K01; browser lifecycle C09 ещё открыт).
- R02 **DONE локально + BROWSER/LOCAL**, VPS для candidate ещё не обновлён.
- R03 **DONE локально + BROWSER/LOCAL** (canonical inspector + full replace + conflict preservation).
- R04 **DONE локально + BROWSER/LOCAL** (4 block kinds and type-specific fields).
- R05/R06/R08/R09 **OPEN**; R07 **PARTIAL**.

Следующая точная операция: K04 — допустимые связи, ports, drag/zoom/fit и collision-aware layout.

## K04 — связи, жесты и collision-aware layout — DONE локально + BROWSER/LOCAL

- `apps/studio/src/board-model.ts` теперь строит fallback без пересечений: четыре type columns (`location`, `character`, `resource`, `action`), локальный индекс вида и шаг 160px; saved positions по-прежнему имеют приоритет.
- `apps/studio/src/board-dom.ts` добавляет явный SVG `marker-end` (`#board-arrowhead`) на каждую derived edge; `onConnect` остаётся типизированным и app применяет `edgeToDraftChange` как полный `block.replace`.
- Editable board: port/body drag создаёт только `character→location` или `action→resource`; остальные комбинации показывают hint и не меняют edge count. Header drag меняет position live и обновляет path geometry; text inputs не запускают gestures.
- Static: `npm run typecheck` exit 0; board-model **7/7**; полный Studio suite **81/81**.
- BROWSER/LOCAL на чистом Chrome profile и отдельной SQLite: valid connection подняла edge count `1→2` с marker; invalid `resource→location` оставила count `2` и показала unsupported hint; два header drag изменили transform и edge `d` оба раза; wheel изменил `41%→47%`, Space+drag изменил pan, «Показать всё» вернул fit `41%`; localStorage подтвердил сохранённую координату; переключение Properties/AI/Properties сохранило transform и 5 nodes.

Ограничение: layout пока localStorage и не доступен другому браузеру; это закрывается K05 BoardDocument.

### R status after K04

- R01/R02/R03/R04/R05/R06 **DONE локально + BROWSER/LOCAL** (VPS candidate ещё не обновлён).
- R07 **PARTIAL**; R08/R09 **OPEN**.

Следующая точная операция: K05 — серверный BoardDocument persistence, revision/idempotency, restart и другой браузер.

## K05 — server BoardDocument persistence — DONE локально + BROWSER/LOCAL

- Добавлены `BoardDocument`, `BoardPosition`, `BoardDocumentStore` и CAS result types в `packages/control/src/types.ts`; canonical draft/contentHash не изменены.
- `SQLiteControlStore` получил `control_board_documents` и `control_board_idempotency`; schema v1→v2 migration выполняется при startup, future versions fail-closed. Validation: max 1000 positions, finite coordinates in `[-1000000,1000000]`, exact keys, actor audit, atomic `BEGIN IMMEDIATE`.
- Added `GET /control/v1/projects/:projectId/quests/:questId/board` and `POST .../board/changes`; POST requires existing idempotency key, CAS `baseRevision`, replay returns same board, changed payload with same key returns 409, stale revision returns 409. Existing auth/role/mutation-proof gates are reused unchanged.
- `apps/studio/src/api.ts` reads BoardDocument and sends full position maps; `app.ts` loads server positions independently from draft, coalesces drag saves at 700ms, updates board revision, and falls back to localStorage only when Board API is unavailable.
- Registry source `packages/contracts/registry/endpoints.json`, generated `docs/agent/api.openapi.json`/compatibility and migration runbook `docs/migration/2026-09-10-board-document.md` updated through `docs:generate`.

Проверено:
- RED: new SQLite test initially failed because `getBoardDocument` was absent.
- GREEN: `packages/control/test/board-document.test.mjs` → **2/2** (CAS, replay, key reuse, bounds, atomicity, close/reopen, v1 migration).
- `apps/server/test/board-document-http.test.mjs` → **1/1**; full Control → **99/99**, full Server → **122/122**, full Studio → **81/81**.
- `npm run typecheck` exit 0; `npm run docs:generate` exit 0; `loadInstalledAgentKit()` hash guard passed.
- BROWSER/LOCAL profile A on fresh server `4186`/isolated SQLite: drag persisted through real board POST; profile B on separate Chrome profile with empty localStorage read `boardRevision=1`, `positions.item-tp6n7a={x:451,y:77}`, and DOM `translate(451px,77px)`.

Следующее: K06 — hosted identity, project/global permissions и provider mutation security.

## K06 — hosted identity, permissions и provider mutation security — DONE локально

- Existing `control-server.ts` identity path verified: HttpOnly session token → server-side session lookup → user lookup; project role is read live per request, not accepted from UI/header.
- Added `apps/server/test/board-permissions-http.test.mjs`: tester can GET board but cannot POST; editor with CSRF can POST; missing/forged owner headers do not elevate tester; changing editor→tester blocks the existing session; revoked session returns 401.
- Existing `apps/studio/test/live-author-provider-lifecycle.test.mjs` extended with non-loopback Host and cross-site Origin/Fetch-Metadata cases; both return 403 before provider body/mutation. Provider credential remains process-memory and is never returned.

Проверено:
- Node 24.19.0 `npm run typecheck` → exit 0.
- K06 role/revocation test → **1/1**.
- Provider lifecycle/security test → **1/1**.

Ограничение: доказательство пока локальное; live Telegram-gate/nginx/VPS identity matrix и C01–C18 переходят в K07/K08. GREEN не объявлен.

## K07 — V00 assets, auth boundary и independent Player — DONE локально + VPS unauthenticated

- Studio static entry and Player asset namespace remain separate: `/studio-assets/*` and `/player-assets/*`; no root `/styles.css`/`/app.js` restoration.
- Local tests passed: Studio static/shell, Player UI/runtime, Player launch serialization and local Control/Studio boundary — **20/20** selected tests.
- Public read-only VPS matrix on `https://85.137.95.104.sslip.io:8741`: `/studio-assets/*`, `/player-assets/*`, `/player-meta.json`, `/v1/*` unauthenticated → **401**; legacy `/styles.css` and `/app.js` → **410**; navigation `/` → **200** login fallback. No cookies or state writes used.
- Logged-in Telegram browser playtest on the public VPS is not claimed: no session was available in this run. Existing local independent frozen Player path is the evidence for runtime behavior.

Не закрыто: C01–C18, full verify and exact-SHA VPS Studio deployment/smoke (K08). GREEN не объявлен.

## K08 — acceptance matrix / deployment — PARTIAL, auth browser OPEN

- Added `apps/studio/test/correction-acceptance.test.mjs`: local result **18 tests, 17 passed, 1 skipped (C18 without live URL)**; with `CORRECTION_VPS_URL`, C18 boundary check passed for public `/` 200, protected asset/runtime 401 and legacy roots 410.
- Full `npm run verify` initially caught the expected registry count drift `42→44`; `b10-registry.test.mjs` was corrected and focused test passed. The rerun of full verify exited **0**, including docs/boundaries.
- Candidate `fb0483c` was delivered through the branch, remote worktree reset exactly to that SHA, Studio image rebuilt (`sha256:5411…`) and only `lhc-studio` recreated with `--no-deps`. Remote readback: Studio loopback 200, Engine health 200, gate/Engine remained running.
- Public unauthenticated VPS matrix after deploy: `/studio-assets/*`, `/player-assets/*`, `/player-meta.json`, `/v1/*` → 401; `/styles.css`/`/app.js` → 410; `/` → 200 login fallback.
- Authenticated Telegram browser smoke remains OPEN: no usable session was available, local-cookie browser probe timed out, and no credentials/tickets were guessed. Local Chromium/CDP scenario is complete and recorded for C01–C17.

Next blocking item: use an already authenticated Telegram browser session (or user-performed login) to execute the public quest/editor/read-only/playtest path. Do not declare GREEN before that evidence.
