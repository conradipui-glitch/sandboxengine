# 2026-09-09 — L05 frozen Player launch from Studio

Branch: `feat/live-author-studio`
Baseline for this slice: `d47053c` (L04 commit).

## Result

- new reusable launcher `apps/player/src/launch.ts`: `launchFrozenPlayer({databasePath, playtestId, port?, host?})` returns an explicit outcome (`ok` with `url`/`close()`, or `playtest_not_found` / `unsupported_playtest` / `invalid_playtest` / `display_incomplete` / `listen_failed`); the frozen snapshot is loaded from the same SQLite DB, never from the live draft; running players are tracked per process (`isPlayerRunning`, `closePlayer`, `closeAllPlayers`); failure paths close every opened SQLite handle;
- CLI `apps/player/src/main.ts` refactored onto the same launcher; env contract (`LH_DATABASE_PATH`, `LH_PLAYTEST_ID`, `LH_PLAYER_PORT`, `LH_RUNTIME_PORT` accepted) and the `Living History Player: http://…` output line stay compatible;
- Studio `main.ts` wires a `playerLauncher` onto the same `databasePath` (no shell command is built, no arbitrary DB path is exposed); Studio shutdown calls `closeAllPlayers()`;
- Studio `dev-server.ts` gained `POST /local/launch-player {playtestId}` behind the same local-operator loopback policy as settings (Host/port/Origin/fetch-metadata, 8 KiB body cap, unknown fields rejected); concurrent launches are serialized, and the launcher itself guarantees at most one Player per Studio process — a repeat request for the same playtest returns the working URL;
- Studio UI (`app.ts`): the ready-playtest panel now has «Открыть в Player» with the resulting link rendered inline (no popup dependency); clear refusals for unknown playtest and unsupported action count; manual terminal commands moved into a collapsed fallback `<details>`;

## Verification

- `npm run typecheck` — exit 0;
- `node --test packages/player/test/launch.test.mjs` — exit 0, 2/2 (real SQLite: launch → repeat same URL → close → relaunch; unknown id and 2-action playtest refuse closed);
- `node --test apps/studio/test/live-author-player-launch.test.mjs` — exit 0, 1/1 (405 method, foreign Origin 403 without a launch, invalid body 400, unknown 404, unsupported 409, concurrent same-playtest POSTs return one identical URL);
- `node --test packages/player/test/launch.test.mjs packages/player/test/player-e2e.test.mjs apps/studio/test/live-author-*.test.mjs` — exit 0, 8/8;
- `packages/player` group — 23/23; `apps/server` group — 121/121; `apps/studio` group — 56/60 (the same 4 pre-existing B05/B10-era failures);
- `apps/player/test/player-ui.test.mjs` — 3/4 both with and without L05 changes (`git stash` re-run): the `dev:player` boot test fails in the after-hook with a Windows `EBUSY` on immediate temp-dir removal — pre-existing flake, not a regression; the boot itself succeeds and serves the authored cost;
- no paid API call; Node `24.18.0` vs `>=24.19.0 <25` remains an environment limitation.

## Acceptance

L05 accepted: a user can open the frozen playtest in Player from the Studio panel without a terminal; exactly one managed Player exists per Studio process; repeated and concurrent requests reuse it; shutdown releases ports and SQLite handles.

Next card: L06 — end-to-end cycle through the real HTTP adapter (settings endpoint → studio proxy → control → Player).
