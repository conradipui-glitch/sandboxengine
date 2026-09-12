# FIN-01 (B02), second pass — the public delivery contour was not actually frozen

Date: 2026-09-11
Card: FIN-01 / defect B02. Follow-up after an independent adversarial pass
(worktree `C:/Temp/lhc-fin01-verify`, branch `feat/fin01-adversarial-verify`)
that tried to *refute* the first FIN-01 fix instead of confirming it.

## What the adversarial pass found (all three live, all proven by red tests)

1. **The pin could be skipped silently.** `resolveReleaseBundle(...).catch(() => undefined)`
   at build time swallowed every failure, so a build whose referenced asset did
   not exist still answered `201` and registered a release with **no pin**. The
   later publish then fell back to "the newest draft", so a release built at
   revision 1 began serving revision 2.
2. **A pinned asset replaced after the pin was served silently.** `publish`
   answered `409 ASSET_CHANGED`, but `POST /public/v1/missions/:id/sessions`
   answered `201` and the asset route served bytes whose digest no longer matched
   the pin the catalog was advertising.
3. **A legacy (pin-less) publication record could rewrite its own identity.**
   Rolling back over a changed asset answered `200` and the *same* `releaseId`
   started advertising a different bundle `contentHash`.

## Change

- **Build freezes before the release exists.** The build route resolves the
  bundle first and answers `422 RELEASE_FREEZE_FAILED` when it cannot, so a
  release is never registered with an empty freeze.
- **Publishing never reads "the draft as of now".** The pin records the authored
  revision that was newest **at build time** (`missionRevision` +
  `missionContentHash`); publish and rollback resolve that revision, never the
  latest one. This is what closes "built at r1, serves r2".
- **Session creation re-checks the pinned manifest.** When the release has a
  verified pin and the live library no longer matches it, the public session
  route answers `409 PUBLIC_MISSION_ASSET_CHANGED` instead of handing a player a
  release whose artwork changed underneath.
- **An adopted (pre-freeze) pin keeps the identity it already advertised.**
  `bundleHash` is taken from the existing record rather than re-derived from the
  live library, so one `releaseId` cannot start reporting a different bundle.

## Test

`apps/server/test/fin01-release-contract.test.mjs` (+ `fin01-release-support.mjs`),
4 tests: **3 of them red before this change** (session created on a broken
bundle; publish served the newest draft; legacy rollback rewrote the hash), all
4 green after. The support module drives the real stores and the real HTTP
server — no mocks.

The adversarial pass also left six *characterising* suites
(`fin01-verify-*.test.mjs`) that describe the pre-fix behaviour on purpose; they
now fail by design. They stay in `origin/feat/fin01-adversarial-verify` as the
record of what the old behaviour was, and are deliberately not carried into this
branch — the normative contract above replaces them.

## Not verified

- The window between `pinRelease` and the pointer move is still two operations,
  not one transaction: a crash in between is not covered by a test.
- Migrating a real pre-fix database is exercised on a memory/SQLite fixture only.
- No hosted (nginx, gate, BFF) run of these paths yet, and `cache-control` on
  asset bytes is not re-checked by this contract.
