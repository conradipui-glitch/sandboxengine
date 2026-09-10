# Передача работы

Обновлено: 2026-09-11

Текущий блок: **M06 PARTIAL (независимая проверка + корректирующие R01–R03 выполнены локально). OPEN: R04 воспроизводимое размещение (F07), повторная доставка exact-SHA и live-приёмка, R05 закрытие, C18 ролевые проверки.**
Рабочая ветка: `feat/b13-acceptance-closure`. Входной SHA correction: `bc8313d31bca1fb0526e4b18a31d3ddd5bdbf7d9`. Авторизация `@living_history_gate_bot` и V00 asset namespaces не меняются. Карточка: [2026-09-10-STUDIO-V00-V02-correction.md](worklog/2026-09-10-STUDIO-V00-V02-correction.md).

## Независимая проверка M06 и корректирующие работы (2026-09-11)

Внешний аудит признал предыдущий отчёт о завершении M06 недействительным: hosted happy-path работал, но полная приёмка не проходила. Все семь дефектов воспроизведены регрессионными тестами и исправлены, кроме F07.

| Дефект | Severity | Исправление | Проверка |
|---|---|---|---|
| F01 сохранение черновика ломает опубликованную игру | P1 | `5475da0` | `apps/server/test/m06-immutable-release.test.mjs` 4/4 |
| F02 неуспешная публикация частично меняет состояние | P1 | `5475da0` | там же (каталог пишется до указателя, откат при отказе promotion) |
| F03 unpublish убивает начатую игру | P1 | `5475da0` | там же |
| F04 финал теряется при reload сайта | P1 | site `f7f1233` | `src/worker/public-mission-recovery.test.ts`, `b11-public-route.test.ts` |
| F05 опубликованные миссии не идут через общий renderer | P1 | site `db7cbe8` + engine `8ebe741` | `frame-build.test.ts`, `published-mission-stage.test.tsx`, `b11-public-route.test.ts` |
| F06 отсутствующая миссия падает в legacy, каталог теряет legacy-карточки | P2 | site `db7cbe8` | `b11-catalog-route.test.ts` 4/4 |
| F07 authored-runtime не восстановится штатным перезапуском | P1 | **НЕ исправлено** | — |

Ключевые решения:

- Опубликованный контент и открытая сессия разрешаются по неизменяемому `contentRevision` (`getMissionAtRevision`), а не по latest draft; сессия создаётся с явным pin.
- Публикация новой версии перекрепляет каталог (`draftRevision`/`draftContentHash` = текущая авторская ревизия) вместо отказа `PUBLICATION_SOURCE_STALE`; stable id/slug сохраняются.
- `contentHash` каталога — bundle-identity: renderer contract + авторский `missionContentHash` (story, screens, listing, defaults) + дайджесты используемых ассетов. Quest-board compile hash намеренно не используется как идентичность MissionDraft.
- Каталог пишется до release pointer; при отказе promotion выполняется компенсирующий откат каталога.
- Continuation игры не требует активной публикации: unpublish блокирует только новые запуски.
- Терминал (финал) хранится в binding, GET реконсилируется с движком — потерянная запись DO самоизлечивается.
- Публичные ассеты опубликованной ревизии отдаются по `/public/v1/missions/:id/assets/:assetId`; при unpublish отзываются; всё, что ревизия не упоминает, остаётся приватным.

Регрессия после R01–R03 (Node 24.19.0):

- Engine `npm run build` (tsc -b) — exit 0;
- Control 106/106, Server 133/133, Contracts 57/57, fail 0;
- Site `npm run check` — exit 0; Vitest 18 файлов / 82 теста, fail 0; production build — exit 0.

Не выполнено в этом этапе (честно): F07/R04 (отдельный управляемый authored-service, healthcheck, вынос `/tmp`-конфигурации), повторная доставка новых SHA на VPS, браузерный проход двух непохожих миссий на живом сайте, C18 ролевые входы. M06 остаётся PARTIAL до live-подтверждения.

## M06 hosted acceptance (2026-09-11, до независимой проверки)

- SSH восстановлен из проектных данных: ключ [REDACTED], host 85.137.95.104, port 48176, user root; ключи для root без порта 48176 не работают — отказ «ключей root» был следствием неверного порта.
- Engine доставлен на `b1546dad200aa9995b0b1d98bbabad20047b19e7` (M06 `df07f5f` + hosted-фиксы `4fdfd74`, `b1546da`), worktree чист.
- Site preview Worker пере деплоен из `c604421` (`feat/florence-vertical-slice`, M06 `b00b7d1` + hosted-config commit) через workflow run 34510822807, version b27f01fa.
- Hosted-фиксы, найденные при приёмке (оба закоммичены и задеплоены):
  - Studio control server не получал `publicationStore` → публикации не появлялись в каталоге (`4fdfd74`);
  - regex публичных маршрутов не матчил percent-encoded `publicMissionId` → Worker BFF получал 401 (`b1546da`).
- Конфигурация: override `/tmp/lhc-m06-compose-override.yml` задаёт `LH_PUBLIC_MISSION_SESSION_SECRET` (значение [REDACTED]); runtime 8742, authored runtime 8746 (`docker exec -d lhc-engine node /engine/deploy/vps/authored-server.mjs`), nginx 8743: `/public/v1/missions` → control 8788, `/` → 8746.
- Worker vars: `ENGINE_PUBLIC_CATALOG_URL` и `ENGINE_PUBLIC_MISSION_URL` добавлены в `wrangler.jsonc`; DO `PublishedMissionRouteSession` и миграция `v4-m06-published-missions` задеплоены вместе с Worker.
- Приёмочные доказательства (hosted):
  1. `/public/v1/missions` отдал обе миссии; site `/api/scenarios` их зеркалирует;
  2. Alpha: create session → turn 1 → turn 2 → `status: victory` через site BFF;
  3. Beta: сыграна до `victory` так же;
  4. reload по id сессии вернул сохранённое состояние (turn 2, финальная сцена);
  5. unpublish Beta (owner CAS по expectedReleaseId) убрал её из engine-каталога и site-каталога; повторное создание игры Beta → 500 (нет в каталоге), Alpha и legacy Florence работают (201);
  6. legacy Florence продолжает играть через тот же Worker (регрессии нет).
- Не покрыто: C18 editor/viewer/read-only — на gate есть только один Telegram-owner; нужны отдельные аккаунты для ролевых проверок.


## L00 — baseline review (2026-09-09)

- база: `6f2ad73fca228c60361012250b72609447edc968`;
- HEAD: `1bc76c1facbb84ea573f7e29908dfa1d7bc5cb7b` (два commit от базы: scaffolding + L00 bookkeeping);
- `npm ci` — exit 0, но Node `24.18.0` дал environment-only `EBADENGINE`; требуется `>=24.19.0 <25`;
- `npm run typecheck` — exit 0;
- `node --test apps/studio/test/b10-full-author-assistant-cycle.test.mjs` — exit 0, 1/1 pass;
- browser, HTTP adapter, live provider и Player launch пока не доказаны.

## L01 — local HTTP boundaries (2026-09-09)

- shared loopback Host/port + Origin + fetch-metadata policy now guards settings, Studio proxy and direct local Control;
- proxy and Control request bodies are bounded before mutation/upstream forwarding;
- unknown settings fields, forbidden provider targets and unsupported methods fail closed;
- `npm run typecheck` — exit 0;
- `node --test apps/studio/test/live-author-boundary.test.mjs` — exit 0, 1/1;
- `node --test apps/studio/test/proxy-auth.test.mjs apps/server/test/control-http.test.mjs` — exit 0, 7/7;
- no upstream call and no draft mutation on rejected requests;
- Node `24.18.0` vs required `>=24.19.0 <25` remains an environment limitation.

## L02 — ModelProvider → AgentBackend (2026-09-09)

- server-owned bridge now calls the existing OpenAI-compatible adapter with bounded JSON request data;
- deadline, per-turn cancel, close, disconnect/rotation, busy and eight-session limit are explicit;
- provider 401/403/429/timeout/abort/invalid JSON/network outcomes map to AgentBackend codes;
- known provider usage and request IDs survive structured failures; no secret or gameplay authority is exposed;
- `npm run typecheck` — exit 0;
- `npm run test:ai` — exit 0, 46/46;
- no paid API call; fetch-only stubs exercised the real HTTP adapter.

Следующее: L03 — provider settings lifecycle, safe process-memory credential handling and user-visible statuses.

## L03 — provider settings lifecycle (2026-09-09)

- explicit Studio provider state machine: `not_configured → settings_saved → requesting → connected | error`; rotation/disconnect invalidate outstanding sessions;
- `connectionCheck` reflects the real lifecycle outcome; the always-`not_performed` stub is gone;
- status errors use AgentBackend semantics (`auth_required`/`rate_limited`/`timeout`/`invalid_response`/`backend_error`/`network`); raw provider enums are not exposed;
- UI renders all five states with targeted hints; password field cleared on submit/disconnect; key stays process-memory only and is never echoed; `remainingTokens` stays `null` («неизвестен»);
- no-key/rejected-key assistant failures explain where to connect the AI (`backend.auth_required` hint in the assistant progress panel);
- failed settings updates keep the working configuration; no provider call while saving settings;
- `npm run typecheck` — exit 0;
- `node --test apps/studio/test/live-author-provider-lifecycle.test.mjs` — exit 0, 1/1 (new lifecycle test);
- boundary + UI tests — exit 0, 7/7; `packages/ai` + `packages/control` — exit 0, 143/143;
- `apps/studio` group 55/59: 4 failures reproduce without L03 changes (pre-existing B05/B10-era scripted-backend expectations on this branch);
- no paid API call; Node `24.18.0` vs `>=24.19.0 <25` remains an environment limitation.

## L04 — контекст и формат ответа (2026-09-09)

- аудит карточки: пункты 1–6 уже реализованы заготовками и подтверждены (каноническая схема в промпте, small_quest до 32 блоков / 64k символов, entry-режим сохранён, fail до сети, MCP-протокол зелёный, paint-ограничение в контракте);
- пункт 7: устранены литеральные `\n` в user-сообщении (модель получала backslash-n вместо переводов строк);
- новые тесты: `node --test apps/server/test/author-context-l04.test.mjs` — exit 0, 3/3 (correction видит созданные блоки и fresh revision; «увеличь расход краски до двух» даёт один `block.replace` без дубликата id; переполнение контекста падает до сети; настоящие переводы строк);
- `node --test apps/server/test/*.test.mjs` — exit 0, 121/121.

## L05 — запуск frozen Player из Studio (2026-09-09)

- переиспользуемый `apps/player/src/launch.ts` с явными отказами (playtest_not_found / unsupported_playtest / …); CLI переведён на него без ломания контракта;
- `POST /local/launch-player` за тем же loopback-полиси, сериализация запусков, ровно один Player на процесс Studio, повторный запрос возвращает работающий URL;
- кнопка «Открыть в Player» в панели готового playtest + ссылка после старта; shutdown Studio освобождает порты и SQLite-хендлы;
- тесты: `node --test packages/player/test/launch.test.mjs` — exit 0, 2/2; `node --test apps/studio/test/live-author-player-launch.test.mjs` — exit 0, 1/1 (405/403/400/404/409 + конкурентные POST → один URL).

## L06 — сквозной цикл через настоящий HTTP adapter (2026-09-09)

- `node --test apps/studio/test/live-author-full-http-cycle.test.mjs` — exit 0, 1/1 на SQLite-стеке: настройки через endpoint формы → Bearer/model/JSON-format у стаба → apply r0→r1 (повторный apply без новой ревизии) → correction видит созданные блоки и fresh revision → block.replace расхода 1→2 → validate/freeze → launch Player → покраска 1 юнита списывает 2 (замороженное правило) → правка draft после freeze не влияет на запущенную версию → невалидный JSON и 429 не меняют draft/frozen/state.

## L07 — браузерная приёмка (2026-09-09)

- исправлена причина 4 старых падений: `serveStatic` на win32 нормализовал пути с backslash и все собранные браузерные файлы отдавали 404;
- `author-assistant-app.test.mjs` обновлён под текущую композицию (без scripted backend, с playerLauncher);
- реальный Chromium (CDP): desktop 1280×900 и 360×800 — boot, сохранение настроек, очистка пароля, честные статусы, клавиатура/focus, справка открывается/повторяется (8 тем), нет горизонтального скролла, нет overlap, consoleErrors пусто; сняты скриншоты;
- `node --test apps/studio/test/*.test.mjs` — exit 0, **61/61**.

## L08 — живой прогон (2026-09-09)

- **UNVERIFIED: нет доступа к провайдеру** (ключ не предоставлен; чужие ключи не ищутся). Лимиты для будущего прогона зафиксированы в worklog.

Итог L08: живой provider-вызов не подменялся mock-проверкой; L09 закрыт отдельно ниже.

## L09 — финализация и передача (2026-09-09)

- повторное ревью L04–L07: [worklog](worklog/2026-09-09-live-author-L04-L07-review.md);
- свежий локальный `npm run verify` — exit 0: Studio 62/62, Player 29/29, Server 121/121; audit 0 advisories; backup/restore, rollback, boundaries и docs checks прошли;
- Linux CI на исправленном коде `2abd8cadc60ddf5a50b559c3158ef6cd8c2437cd`: run `34302849541` — success;
- §24 спецификации больше не хранит устаревший статус реализации и направляет в `docs/STATUS.md`;
- L08 честно остаётся UNVERIFIED; merge, production deploy и новый release tag не входят в L09.

Следующее: [B13.a2](tasks/B13-BUILDER.md) — bounded agent patch/diff/tree identity в isolated workspace; push и deployment не входят.

Release: `v0.1.0`  
B12 merge: `3e6fcfd9c42910561500aca8c73e639d9bcf2f9b`  
Published `main` CI: #729 / `34251551857` — success

## B12 завершён

- B12.1 companion production external smoke: deploy run `34239102418`, Cloudflare version `cd0d8948-86d3-4a56-9b5f-c97bbec79771`;
- B12.2 SQLite online backup/restore + 12/12 Florence assets + restart recovery;
- B12.3 dependency audit 0/0 + provider 429 no-turn save integrity;
- B12.4 real OpenRouter provider eval: run `34250711595`, model `deepseek/deepseek-v4-flash-0731`, structural contract 12/12, semantic 5/12, 16 attempts, mean latency 12,176 ms, max 25,002 ms; aggregate token usage `null` because telemetry was incomplete;
- B12.5 real Chromium T29 mobile/focus/keyboard smoke: run `34246143800` PASS;
- B12.6 permanent release rollback drill: r1→r2→rollback r1 + restart/session pinning;
- B12.7 persistent Node+SQLite `npm start`, real health/control probes and graceful SIGTERM;
- T01–33/T36–37 matrix consolidated;
- README/runbook/changelog are release-facing;
- final cleaned PR head `abf23383e2e70b80aa6c029da17c6e5ab0a66361`, CI #728 / `34251382755` — success;
- PR #36 merged as `3e6fcfd9c42910561500aca8c73e639d9bcf2f9b`;
- `main` CI #729 / `34251551857` — success;
- tag `v0.1.0` verified at the exact merge SHA;
- temporary tag branch removed by run `34251870134`.

## Live-provider interpretation

The real compatible-provider/contract boundary is accepted, but the selected model is not qualified as the recommended intent-understanding model: semantic score was 5/12 (41.7%) despite 12/12 contract safety. All four narrative cases passed. Provider usage telemetry was incomplete, so total tokens remain `null` rather than guessed.

The API key existed only as a GitHub Actions Secret. The one-shot live-eval workflow was removed after evidence capture and is absent from `main`.

## Codex status

Deterministic adapter/account/controller evidence is green: exact protocol pin, account isolation, quota semantics, logout/rotation, browser/device-code flow and no automatic paid fallback. No authenticated live subscription App Server session is claimed in `v0.1.0`.

## Последующий блок — B13, после L00–L09

B13 допускается после принятого B12, но текущий приоритет пользователя — завершение сквозного авторского маршрута L00–L09. Builder/deployment остаётся отдельным блоком; опубликованные доказательства `v0.1.0` сохраняются.

B13.0–B13.c1 приняты на уровне адаптеров: policy фиксирует exact repository/base SHA и канонические read/write scopes; a1 — read-only clone с HEAD/symlink boundary; a2 — bounded patch job с реальным executor (policy-bounded writes, deterministic `git write-tree` identity, verification runner только по policy); b1 — authorized change set (bounded operationId, grant ≡ policy, push из isolated clone, exact-SHA CI reconciliation); b2 — single preview deployment adapter (fixed workflow dispatch, artifact SHA reconciliation, HTTP smoke; Cloudflare-токены только в CI); c1 — production policy с обязательным per-SHA grant, reconciliation потерянного ответа без нового dispatch и verified rollback с smoke-подтверждением. Живые preview/production dispatch — отдельные шаги приёмки по разрешению оператора. См. [карточку](tasks/B13-BUILDER.md) и worklog-и `2026-09-09-B13-*`.

Последние проверки: CI success `34315990935` на `9f17250` (b1), `34317405839` на `14a1619` (b2); локальный `npm run verify` exit 0, builder 24/24.

Operational procedure: `docs/RUNBOOK.md`. Acceptance truth: `docs/B12-ACCEPTANCE-MATRIX.md`. Evidence ledger: `docs/RELEASE-REPORT.md`.

## Studio V00–V02 correction — K03 DONE локально + BROWSER/LOCAL

- `apps/studio/src/block-inspector.ts` реализует canonical create/replace helper; для edit используется только полный `block.replace`.
- Library/modal создаёт location, character, resource и action; action требует существующий resource.
- Реальный Chromium/CDP на изолированном `127.0.0.1:4184` создал все четыре типа; Control GET подтвердил revision `5` и canonical `data`.
- Inspector edit + 700 ms debounce сохранили title/description на сервере; переключение Properties/AI/Properties не потеряло состояние.
- Conflict smoke: внешний write `r5→r6` оставил server state нетронутым локальной правкой, показал conflict panel, локальный input сохранился.
- Static: Node 24.19.0 `npm run typecheck` exit 0; Studio tests **81/81**.
- Не закрыто этим этапом: K04 connections/layout, K05 BoardDocument/other-browser restart, C01–C18 full matrix и VPS exact-SHA smoke.

Следующее: K04 — valid/invalid connections, ports, drag/zoom/fit и collision-aware layout.

## Studio V00–V02 correction — K04 DONE локально + BROWSER/LOCAL

- Fallback layout разделён на четыре type columns с локальными индексами; regression подтверждает отсутствие пересечений карточек.
- Derived SVG edges получили `marker-end`; valid/invalid connection gestures идут через canonical `block.replace`, недопустимые связи не меняют draft.
- Реальный CDP pointer smoke подтвердил valid edge `1→2`, invalid edge count без изменения, два drag с обновлением path, wheel zoom, Space+drag pan, fit, localStorage position и сохранение transform при переключении вкладок; осталось 5 nodes.
- Static: Node 24.19.0 `npm run typecheck` exit 0; board-model **7/7**; Studio **81/81**.
- Ограничение: позиции ещё только localStorage одного браузера; K05 добавит server BoardDocument/restart/other-browser.

Следующее: K05 — server BoardDocument persistence, revision/idempotency, restart и другой браузер.

## Studio V00–V02 correction — K05 DONE локально + BROWSER/LOCAL

- SQLiteControlStore v2: `control_board_documents` + `control_board_idempotency`, v1→v2 migration, atomic CAS, bounded positions, actor audit.
- Exact GET/POST board endpoints используют существующие identity/project-role/mutation-proof gates; generated registry/OpenAPI и migration runbook обновлены.
- Client отдельно читает server positions, сохраняет drag map coalesced after 700ms, обновляет `boardRevision`, localStorage остаётся fallback только при недоступном Board API.
- Static: typecheck exit 0; Control **99/99**; Server **122/122**; Studio **81/81**; docs:generate/hash guard exit 0.
- Browser: fresh profile A on local `4186` saved drag; separate profile B with empty localStorage read server `boardRevision=1`, `positions.item-tp6n7a={x:451,y:77}`, DOM `translate(451px,77px)`.

Не закрыто: K06 hosted identity/permissions/provider security, K07 assets/auth/independent Player, K08 C01–C18/full verify/VPS exact-SHA. GREEN не объявлен.

Следующее: K06 — hosted identity, project/global permissions и provider mutation security.

## Studio V00–V02 correction — K06 DONE локально

- Board HTTP uses server session identity, live project role and CSRF; tester GET/read works, tester write is 403, editor write works, role downgrade blocks existing session, revoke returns 401; forged owner headers do not elevate.
- Local provider mutation boundary rejects non-loopback Host and cross-site Origin/Fetch-Metadata before body handling; credential stays process-memory and is absent from status.
- Tests: typecheck exit 0; role/revoke **1/1**; provider lifecycle/security **1/1**.

Не закрыто: live gate/nginx/VPS matrix, K07 assets/auth/player, K08 C01–C18/full verify. GREEN не объявлен.

Следующее: K07 — V00 assets, auth 401 и independent playtest/runtime.

## Studio V00–V02 correction — K07 DONE локально + VPS unauthenticated

- Namespaces `/studio-assets/*` и `/player-assets/*` сохранены; root `/styles.css`/`/app.js` не возвращены.
- Selected local static/Player/launch/boundary checks: **20/20**.
- Public VPS без cookie: studio/player assets, player-meta и runtime API → **401**; legacy root assets → **410**; navigation `/` → **200** login fallback.
- Logged-in Telegram browser playtest на VPS не заявлен: сессии в run не было; local independent frozen Player path проверен.

Не закрыто: K08 C01–C18/full verify/exact-SHA VPS Studio deployment + authenticated smoke. GREEN не объявлен.

Следующее: K08 — C01–C18, full verify, deployment and VPS smoke.

## Studio V00–V02 correction — K08 PARTIAL, authenticated browser OPEN

- Acceptance harness: C01–C17 pass; C18 public boundary passes after deploy, authenticated Telegram browser is not verified.
- `npm run verify` under Node 24.19.0 → exit 0 after updating the registry count from 42 to 44 for the two board endpoints.
- Studio-only VPS delivery: final branch candidate read back exactly on the remote; rebuilt image read back; `lhc-studio` recreated with `--no-deps`; Engine health 200 and gate/Engine uptime remained unchanged.
- Public unauthenticated checks: `/` 200 login fallback; namespaced assets/player-meta/runtime 401; legacy root assets 410. No credentials, ticket or cookie was guessed.
- Local browser/CDP scenario remains the completed interaction evidence for C01–C17.

Blocking item: role-separated checks (editor/viewer/read-only) need their own Telegram-gate sessions; one owner session does not prove them. GREEN is not declared.

## Studio V00–V02 correction — K08 C18 owner-scenario PASSED (2026-09-10, VPS live)

- Session: isolated Chrome profile + fresh gate ticket, owner cookie `lhc_session`; remote SHA `59bb112`, Studio loopback 200.
- Isolated mission only: project «C18 Приёмка» + quest «C18 Миссия». «Приёмка VPS» (1 quest) and Florence Workshop untouched.
- Quest open shows working board immediately (start location «Начало», `board-nodes 1`).
- Created via library modals with canonical fields: resource «C18 Краска» (шт), character «C18 Мастер», action «C18 Рисовать» (resourceId preset to the new resource). Nodes 1→4, each step «Сохранено на сервере».
- Inspector edits canonical fields of the selected block (title→«C18 Рисовать v2», resourceId `c18-doj8v1`, units/duration/allowPartial); edit persisted server-side.
- Valid drag character→location created `character-initial-location`; invalid drag resource→character rejected (edges stayed 2: `character-initial-location`, `action-resource` «Расходует»).
- Node drag moved location y 492→592, edges tracked, BoardDocument saved.
- Reload: project list shows C18 (3 of 3 projects); reopened quest has 4 nodes, 2 edges, moved position y=592, edited title — content+layout persisted.
- Validation: «Revision 5 валидна. Можно заморозить playtest», «Квест готов».
- Player: frozen `playtest-3` (revision 5, compiled `6243bb1…1288fb`); VPS loopback `http://127.0.0.1:8745` → **200**.

Следующее: M06 — публикация и generic site catalog/BFF.

## M06 — publication registry + generic site route DONE локально (2026-09-10)

- `packages/control/src/publication-store.ts`: Memory/SQLite publication registry, stable `publicMissionId`/slug, release/content hash + draft revision pin, idempotent publish/replay, owner unpublish и SQLite reopen/migration coverage.
- Existing owner `POST /control/v1/.../publish` теперь синхронизирует published catalog record только при exact current mission revision/hash; rollback repins the same public identity to the selected release. Existing auth/session mechanics unchanged.
- Public engine routes: `GET /public/v1/missions`, slug/id detail, credential-bound session create/get/turn; public payload excludes project/quest internals. Unpublish uses owner role, expected release CAS and idempotency.
- Site worker consumes the catalog through `ENGINE_PUBLIC_CATALOG_URL`; generic `/api/games`/reload/turn path uses a `PublishedMissionRouteSession` Durable Object and keeps engine credential server-side. Florence/legacy route remains fallback for non-published IDs.
- Site runtime wiring includes `PUBLIC_MISSION_ROUTE_SESSIONS` binding and v4 migration in `wrangler.jsonc`; deploy variables and reverse-proxy exposure are intentionally not changed yet.
- Engine tests: M06 publication store **2/2**, owner publish→catalog sync **1/1**, public catalog/unpublish **1/1** and public runtime **1/1**; engine `npm run typecheck` passed. Full Control + Server + Contracts regression: **290/290 pass, 0 fail, 0 skipped** under Node 24.19.0.
- Site: `npm run check` passed; full Vitest **63/63**; production `npm run build` passed; M06 worker/presentation tests included.
- Still OPEN: live deployment of the new engine/control public routes and site worker config, exact-SHA VPS smoke, real two-mission play through the deployed BFF, and C18 editor/viewer/read-only Telegram-gate sessions. No production Engine/gate restart was performed.
