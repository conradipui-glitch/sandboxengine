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
- Both asset routes (public catalog and session) now serve the bytes the release
  **pinned** (`ControlPublicationReleasePin.assets`, matched by asset id), not the
  library's current entry. A session finds its release through the pin whose
  `missionRevision`/`missionContentHash` match the session; the catalog resolves
  the pin of its `releaseId`. Without a matching pin, or for an asset the pinned
  revision does not reference, the answer is 404 — the previous behaviour served
  whatever bytes the library held under that asset id, under an
  `immutable, max-age=31536000` header, so re-uploading an asset silently rewrote
  the artwork of an already published mission.

Defect reproduction first: with the branch disabled the new test fails
(`pass 0 / fail 1`) — the first session asset request answers 404 instead of 200.

## Test

`apps/server/test/fin03-session-assets.test.mjs`, 1 test / 1 pass after the fix
(0 pass / 1 fail with the route disabled).

The repro agent's independent suite `fin03-open-session-assets.test.mjs` (3 cases:
re-uploaded bytes under an immutable URL, an open session after republish, an open
session after unpublish) was RED before the fix — `tests 3 / fail 3` — and is
**3/3 green** on the merged branch. Its RED evidence is what exposed the
fallback-to-library bug in the public route, which the first cut of this fix had
not covered.

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
