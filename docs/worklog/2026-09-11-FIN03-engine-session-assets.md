# FIN-03 (B04), engine half — a started game keeps its own artwork

Date: 2026-09-11
Card: FIN-03 / defect B04 (engine side). Site side is a separate repo change
(`feat/fin03-site-assets`, `fc87d45`).

## Defect

An asset URL was built from `scenarioRef` alone, so it always resolved against
whatever revision was published *now*. A game that had already started therefore
lost (or gained) artwork when the mission was republished — and lost everything
when it was unpublished, even though the running game was entitled to the bytes
of the revision it was pinned to. There was no session-scoped asset route at
all: `GET /public/v1/missions/:id/sessions/:sid/assets/:assetId` 404'd.

## Change (`apps/server/src/control-server.ts`)

- New session-pinned route matched before the catalog routes:
  `/^\/public\/v1\/missions\/([^/]+)\/sessions\/([^/]+)\/assets\/([^/]+)$/`,
  handled by `routePublicMissionSessionAsset`.
- The route resolves the session through the publication store, takes the
  release the session is pinned to (`sessionPublicMissionId` may be a slug or a
  `mission:project:quest` identifier), and serves the asset out of that
  revision's bundle — not out of the current publication.
- Authorization is the session credential issued when the session was created
  (constant-time compare). No credential, a forged credential, or a session that
  does not exist are all refused; an unknown session answers 404 (the route does
  not confirm existence) and a foreign mission identifier answers 404.
- Assets are served `cache-control: private` because the URL is credential-bound.

Defect reproduction first: with the branch disabled the new test fails
(`pass 0 / fail 1`) — the first session asset request answers 404 instead of 200.

## Test

`apps/server/test/fin03-session-assets.test.mjs`, 1 test / 1 pass after the fix
(0 pass / 1 fail with the route disabled).

It builds two releases and plays a real Control + publication-store loop:
upload `cellar-bg` (revision 0) → start a session → the session route serves the
exact bytes, `image/png`, `private`; a credential-less request and a forged
credential answer 401; another session answers 404; another mission answers 404.
Then revision 1 (`attic-bg`) is published over revision 0 and checked from both
sides: the public catalog now serves `attic-bg` and 404s `cellar-bg`, while the
running session still gets revision 0's bytes unchanged. Finally the mission is
unpublished: the public catalog 404s, the running session still gets its bytes.

## Not verified

- No live VPS run. The hosted deployment still runs the previous engine build;
  the session-pinned route has never been exercised through nginx with a real
  gate cookie.
- Site side is not wired to this route yet (separate branch, being done now).
