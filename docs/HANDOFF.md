# Передача работы

Обновлено: 2026-09-09

Текущий блок: **B13.a1 NEXT; B13.0 GREEN; L00–L07 и L09 приняты, L08 UNVERIFIED; B12 опубликован**
Рабочая ветка: `feat/live-author-studio`. Задание L00–L09: [LIVE-AUTHOR-COMPLETION.md](tasks/LIVE-AUTHOR-COMPLETION.md). Карточки L04–L07 повторно проверены и исправлены 2026-09-09; L08 — живой прогон реальной модели — `UNVERIFIED: нет доступа к провайдеру`. L09 закрыт локальным verify и Linux CI. B13.0 принят; следующая работа — B13.a1 без push/deployment authority.

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

Следующее: [B13.a1](tasks/B13-BUILDER.md) — фактический изолированный workspace adapter с exact-HEAD и realpath/symlink boundary; push и deployment не входят.

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

Первый bounded slice B13.0 принят: policy фиксирует exact repository/base SHA и канонические read/write scopes, но не выполняет файловые или внешние операции. Следующая карточка B13.a1 добавляет фактическую изоляцию workspace и realpath/symlink checks до любых push/deployment полномочий. См. [карточку](tasks/B13-BUILDER.md) и [worklog](worklog/2026-09-09-B13-00-builder-policy.md).

Operational procedure: `docs/RUNBOOK.md`. Acceptance truth: `docs/B12-ACCEPTANCE-MATRIX.md`. Evidence ledger: `docs/RELEASE-REPORT.md`.
