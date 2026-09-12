# FIN-02 — an interrupted publish settles when the server starts again

Date: 2026-09-11
Card: FIN-02 / defect B03. Follow-up to `fin02-publication-atomicity.test.mjs`
(staged candidate, CAS, idempotent replay), which left one acceptance line open:
"an error of the first/second step, a lost answer and a **restart between the
stages** leave no contradicting pointer/catalog".

## Defect

A publish is two durable stages: the release pointer is promoted (CAS-checked),
then the catalog record becomes visible (`commitPublicationOperation`). The
staged candidate itself is durable in `control_publication_operations`. A process
that dies between the stages therefore leaves a state nothing in the request path
can observe or repair:

- pointer moved to release-2, catalog still serving release-1, and a `pending`
  operation that no one will ever finish;
- or, if it dies before the promotion, the same `pending` operation with the
  previous release serving normally — and it stays pending for good.

`apps/server/test/fin02-publication-recovery.test.mjs` pins the second half of
that down (RED: both cases failed before the change — the interrupted publish
stayed `pending` after a restart).

The test does not mock the crash: it opens the server on a file-backed SQLite
database, replaces exactly one store method with a thrower for the duration of a
single request (`withOverride` delegates everything else to the real store), and
then restarts the server on the same file, which is what a crash plus a restart
looks like from the database's point of view.

## Change

`apps/server/src/control-server.ts`:

- `settleInterruptedPublications(releases, auth)` — before the server accepts a
  request, every `pending` operation is settled by facts, not by guessing:
  - the pointer already names the staged release → the publish did happen; the
    catalog record is committed (idempotent, so repeating it is safe);
  - the pointer names another release → the publish never happened and the
    staged record was never visible, so the operation is abandoned;
  - the pointer names the staged release but the commit fails → the operation
    stays pending and the pointer is left alone, loudly, because guessing a
    repair there would be worse than an unfinished operation.
- `listen()` awaits it before binding the socket, so the settled state is what
  the first request sees. `rollback` operations settle the same way — their
  target release is equally named by the pointer.

## Test

`node --test apps/server/test/fin02-publication-recovery.test.mjs` → **2 pass /
0 fail** (both failing before the change).

| Case | Crash point | State after the crash | After restart |
|---|---|---|---|
| 1 | commit of the catalog record | pointer = release-2, catalog = release-1, 1 pending | catalog = release-2, pointer = release-2, 0 pending, new games get r2 content |
| 2 | promotion of the pointer | pointer = release-1, catalog = release-1, 1 pending | 0 pending, previous release keeps serving, and a retry publishes r2 normally |

Load-bearing check (mutations applied, then reverted; `git diff` on the file is
clean): inverting the settle decision (`current !== targetReleaseId`) turns the
suite **2 fail / 0 pass**; the pre-change tree is RED in the same two cases.

Severity: the suite covers the acceptance line about a restart between the
stages, on a real SQLite database rather than the in-memory store.

## Not verified

- The restart is simulated in-process (a fresh server over the same database
  file), not by killing the deployed process and letting the supervisor bring it
  back. A hosted smoke with a real `docker compose restart` on the VPS is still
  open — it needs the delivery of a new engine revision.
- Migration of a pre-fix database is still covered by fixtures only; the real
  pre-fix database has not been opened.
- The `MemoryControlStore`/`501 COLLABORATION_STORAGE_UNAVAILABLE` style
  alternates are untouched by this change.
