# FIN-06 — the capability matrix, checked on the wire

Date: 2026-09-11
Card: FIN-06 / C18. Server commit: `apps/server/test/fin06-role-matrix-http.test.mjs`,
`docs/CAPABILITY-MATRIX.md`.

## What FIN-06 asks, and what is local

FIN-06 wants the manual route closed and the rights verified: a viewer/read-only
participant must not obtain a mutation through the UI *or* a direct HTTP call, an
editor must not obtain an owner-only operation, membership must be revocable, and
a foreign project must stay closed. The live half (three real invited Telegram
identities) needs accounts this session does not have; the backend half does not
need them, so it was done here on local test identities.

## What was checked

`fin06-role-matrix-http.test.mjs` runs a real Control server (SQLite store, release
and publication stores, `MemoryControlSecurityStore`) with four identities — owner,
editor, tester, outsider — and drives the routes through real login sessions:

- **the matrix route by route**: 13 allowed checks and 20 refused ones. A read-only
  (`tester`) session reads draft, mission, board, releases and playtest traces, and
  is refused on every mutation: draft/changes, mission save, board/changes, release
  build, publish, rollback, unpublish, members. An editor passes the editing routes
  and is refused on publish, rollback, unpublish and members. An outsider is refused
  everywhere — as `404`, because a non-member must not learn that a project exists.
- **membership changes bind at once**: demoting the editor to `tester` in the store
  turns the next write into `403 CONTROL_FORBIDDEN`; removing the tester from the
  project turns the next read into `404`; revoking a session turns the next publish
  into `401 CONTROL_AUTH_REQUIRED`.
- **a role cannot be forged**: `x-lh-user-id: owner` / `x-user-role: owner` on a
  read-only session still yields `403`; a valid editor session without the CSRF proof
  yields `403 CONTROL_CSRF_REQUIRED`.
- **the public contour is not a bypass**: `/control/v1/...` without a session is
  `401 CONTROL_AUTH_REQUIRED`, and `/public/v1/missions` answers `200` while the
  unpublished draft's slug is absent from the listing.

The matrix itself is in `docs/CAPABILITY-MATRIX.md`, derived from the
`requireProjectRole` calls in `apps/server/src/control-server.ts` and from
`authorizeProject` (non-member → 404, insufficient role → 403).

## Red first, and mutation-checked

The suite was run before it was trusted: the first run failed on three real
assumptions (GET with a body, the 404/403 split, and locked SQLite handles) and the
test was corrected against the actual server behaviour, not the other way round.

Two source mutations were then applied and reverted, to show the suite is load-bearing:

1. `publish` requiring `owner` → `editor`: the editor publish check turns red
   (`400` instead of `403`).
2. `requireMutationProof` no longer requiring the CSRF token: the "roles cannot be
   forged" test turns red (`CONTROL_CSRF_INVALID` instead of `CONTROL_CSRF_REQUIRED`).

Both were reverted; `git diff -- apps/server/src packages` is empty and the full
server suite is green afterwards.

## Result

- `apps/server/test/fin06-role-matrix-http.test.mjs` — 3/3 pass.
- Server suite: **160/160**, `typecheck` exit 0, `tsc -b --force` exit 0.

## Not verified / open

- **Live C18**: real invited owner/editor/viewer sessions through the Telegram gate.
  C18 stays PARTIAL until then; the gate was not weakened and no owner cookie was
  used as three roles.
- **Telegram identity binding**: rights bound to a confirmed numeric Telegram ID, and
  inviting by username, are not proven by local identities.
- **Two open decisions for the owner** (`docs/CAPABILITY-MATRIX.md`): whether a
  separate `viewer` role is wanted (today read-only is `tester`), and whether a
  read-only participant may comment in collaboration (today the write needs `editor`).
