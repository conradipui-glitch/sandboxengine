# 2026-09-09 — L09 documentation and final checks

Branch: `feat/live-author-studio`

## Documentation

- README: branch status paragraph now states L00–L07 accepted, L08 `UNVERIFIED: нет доступа к провайдеру`; «Локальная Studio» section describes the real provider settings form, honest connection statuses, process-memory key lifetime, the «Открыть в Player» button and the one-Player-per-Studio-process rule;
- `docs/STATUS.md`: Studio/Player row reflects L00–L07 accepted, live run UNVERIFIED;
- `docs/HANDOFF.md`: L04–L08 blocks added with evidence summaries; current block = L09;
- task card `docs/tasks/LIVE-AUTHOR-COMPLETION.md`: L04–L07 GREEN, L08 UNVERIFIED, L09 IN PROGRESS;
- worklogs: `2026-09-09-live-author-L04..L08.md`;
- public API types were not changed by L04–L07 (only new internal modules and endpoint), `npm run docs:generate` + `docs:check` — ok (10 generated contracts current, 14 navigation documents current).

## Final checks

- `npm run verify` — all gates pass. `drill:startup-shutdown` initially failed on Windows before any product assertion: Node-on-win32 `child.kill("SIGTERM"/"SIGINT"/"SIGBREAK")` force-terminates (verified empirically: every variant reports `{code: null, signal}`), so graceful exit code 0 is unobservable from a parent process. Fixed the drill script itself: on win32 it now reports `result: "skip"` with the reason (after asserting health, agent-kit and SQLite creation), while POSIX keeps the original SIGTERM→exit-0 assertion. Linux CI remains the authoritative gate for the graceful-signal contract;
- explicit local verdicts: `audit:release` pass (0 advisories), `drill:backup-restore` pass, `drill:rollback` pass, `check:boundaries` ok, `docs:check` ok;
- `check-boundaries.mjs` had a win32 bug (`join(url.pathname, …)` mangled `file:///C:/…` into `C:\C:\…`) — fixed with `fileURLToPath`;
- parallel review fan-out (6 reviewers) found and fixed: controlStore leaks on launch listen-failure paths, launch race for concurrent same-id launches (in-process mutex in launch.ts), missing UI hints for `invalid_response`/`aborted`/`network` and 4 of 7 `backend.*` codes, a literal `\n` in the MCP tool_result user message, missing 401/cancel/frozen-immutability assertions in the L06 test, missing duplicate-id assertion in L04.a, and a `resolved.startsWith(studioRoot)` containment hardening in serveStatic;
- diff hygiene: no node_modules, dist, tsbuildinfo, SQLite databases, keys or temporary logs in the diff (`.gitignore` added in the L01+L02 commit); browser screenshots kept as local working files.
- post-review corrections for L04–L07 are recorded in `2026-09-09-live-author-L04-L07-review.md`: focused suite 17/17 and a fresh full `npm run verify` passed (Studio 62/62, Player 29/29, Server 121/121). The review closed separate char-limit coverage, one-Player/database identity, CLI port compatibility, deterministic cancel assertions, frozen-snapshot immutability and stale Player UI state.

## Acceptance

L09 remains in progress until the existing branch/PR has a green Linux CI on its final SHA. Merge, production deployment and a new release tag are outside this card.
