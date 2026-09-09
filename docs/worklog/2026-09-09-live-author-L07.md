# 2026-09-09 — L07 browser acceptance (desktop and 360 px)

Branch: `feat/live-author-studio`
Baseline for this slice: `356735e` (L06 commit).

## Environment

Real Chromium 152 (headless, CDP-driven) against the real dev stack: SQLite Control + Studio proxy + settings endpoint + Player launcher (`scripts/l07-studio-boot.mjs`). Screenshots: `l07-desktop-initial.png`, `l07-desktop-settings.png`, `l07-desktop-error.png`, `l07-desktop-project.png`, `l07-desktop-help.png`, `l07-mobile-360.png` (local working files, not committed).

## Regression found and fixed (root cause of 4 standing test failures)

- `serveStatic` allowlist compared POSIX prefixes against `node:path.normalize` output; on win32 `dist/src/app.js` normalized to `dist\src\app.js` and failed `startsWith("dist/")`, so **every compiled browser entry 404'd on Windows**. Fixed by converting the normalized path back to forward slashes after `..`-segment stripping. This makes `static-entry`, `playtest-bridge`, `b05-canonical-audit` and `author-assistant-app` groups green again (they were the 4 known standing failures since L00).
- `author-assistant-app.test.mjs` (B10.a) expected the removed B10-era scripted backend id in `main.ts`; updated to assert the current composition: durable SQLite stores, `LocalAuthorProvider` + `backend: authorProvider.backend`, no `studio-dev-scripted-author`, `playerLauncher` wired, no `child_process`.
- Onboarding tour copy for the Player step now mentions the «Открыть в Player» button (terminal command kept as fallback).

## Steps actually performed (browser)

1. Desktop 1280×900: page boots, app renders, provider form present, status shows honest «ИИ не подключён…»; `consoleErrors: []`; no horizontal overflow (1265 ≤ 1280).
2. Settings: details opens; compatible preset fills; baseUrl editable for `compatible`; submit → status becomes «Настройки сохранены. Отдельная проверка соединения не запускалась…»; **password field cleared**; model field repopulated from server response.
3. Keyboard: `#provider-disconnect` is focusable (`document.activeElement` check passes); focus-visible styles exist in onboarding styles.
4. Reload: saved config (preset/model) and status survive a normal render — no data loss.
5. Invalid submit (empty model): form stays, no crash, no raw enum shown (HTML5 `required` blocks submit; status text unchanged).
6. Authoring path through the UI: project «L07 Приёмка» created via the project form; quest «Мастерская» created via the quest form (labels/keyboard order verified by form field order); no unhandled page errors.
7. Help: `#studio-help-trigger` opens the `role="dialog"` panel with 8 topics; close and reopen (repeat) both work.
8. Mobile 360×800: `scrollWidth 360 ≤ innerWidth 360` — no horizontal scroll from the provider panel; onboarding elements do not overlap the provider panel.

## Verification

- `npm run typecheck` — exit 0;
- `node --test apps/studio/test/*.test.mjs` — **exit 0, 61/61** (4 pre-existing failures fixed);
- `apps/server` + `packages/player` + `packages/control` + `packages/ai` — exit 0, 287/287;
- no paid API call (provider never called during UI checks; a non-listening port was used for the custom URL);
- Node `24.18.0` vs `>=24.19.0 <25` remains an environment limitation.

## Acceptance

L07 accepted on the recorded browser evidence above (desktop + 360 px, keyboard/focus/help/overlap/overflow/error-copy checks with zero console errors). Waiting/cancel states are covered by the L03 status machine; Player start error copy is exercised by the L05 endpoint tests.

Next card: L08 — bounded live run with a real provider key (needs operator access; UNVERIFIED without it).
