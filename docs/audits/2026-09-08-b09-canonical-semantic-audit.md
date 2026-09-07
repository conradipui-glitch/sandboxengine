# B09 canonical semantic audit — B09-01 + B09-02 + B09-03

Date: 2026-09-08

Scope: authenticated Control authority, immutable publication, draft/version lifecycle, portability, Studio completion and persisted playtest evidence before the B09-03 Publication Gate.

## Findings

### Identity, roles, Origin/CORS and CSRF

- B09-01 owner/editor/tester project-role authority remains server-side.
- New B09-03 reads preserve project scoping/project-hiding behavior.
- Restore/clone/import and existing authoring mutations require editor authority and mutation proof; publish/rollback remain owner-only.
- Studio role state only changes presentation. Server authorization and CSRF remain decisive.
- Existing B09-01 Origin/CORS/session regressions remain part of root `npm run verify`.

Result: **no blocker**.

### History, restore and conflict semantics

- History reads existing immutable draft snapshots; Memory/SQLite ordering and old-snapshot preservation are covered.
- Restore creates a new revision, preserves the source snapshot, is idempotent and rejects stale base revisions without mutation.
- Comparison is deterministic and does not auto-merge.
- T22 integration (`apps/studio/test/b09-t22-conflict-integration.test.mjs`) proves two clients: stale r0 write receives `409 DRAFT_REVISION_CONFLICT`, authoritative server r1 is preserved, server diff is visible, and only an explicit retry against r1 creates r2.

Result: **no blocker**.

### Reference/deletion safety

- Typed reference analysis covers canonical quest entry location, character initial location and action resource relations.
- Preflight and actual `block.remove` share the same semantic reference logic.
- Memory/SQLite regression proves a stale green preflight cannot authorize deletion after a new reference appears.
- Studio deletion UX shows concrete source/path evidence, never offers confirmation for referenced/missing/stale analysis, and still submits a normal server mutation that rechecks current draft truth.

Result: **no blocker**.

### Clone identity and source isolation

- Clone creates a new quest/draft, remaps block IDs deterministically and rewrites supported internal typed references.
- Unsupported reference shapes fail closed.
- Source draft/history remain independent; clone retry is idempotent and changed request identity on the same key conflicts.
- Studio portability regression exercises clone through the real Control proxy and confirms independent remapped IDs.

Result: **no blocker**.

### Export exactness and secret/state exclusion

- Draft export is bound to an exact selected revision and remains byte-identical when later source revisions are created.
- Release export is bound to exact immutable release identity/hash and does not move `currentReleaseId`.
- Package structure is deterministic and hash-addressed.
- Export regressions assert absence of Control session/CSRF/token material, playtest/runtime world/player state and provider/private prompt fields.
- Studio downloads the server-produced archive envelope and does not rebuild package contents in the browser.

Result: **no blocker**.

### Import hostile-input boundary and atomicity — T25

- Canonical package import reconstructs equivalent authored content as a **new unpublished draft**.
- Import rejects traversal, absolute and NUL paths, normalized duplicates, symlink-like entries, unsupported compression/content types, oversized archive/member/file count, SHA-256 mismatch, unsupported format/schema/plugin requirements, executable/HTML-like content, forbidden secret-shaped sections and invalid references.
- Failed import creates no partial quest/assets and does not consume a successful idempotency result.
- Identical retry returns the same draft; changed request identity conflicts.
- SQLite reopen preserves import idempotency.
- Studio does not implement a second ZIP/parser boundary; it sends the selected archive to this tested server/control parser and surfaces concrete failure causes.

Result: **T25 satisfied; no blocker**.

### Immutable releases and Runtime session pinning

- B09-02 releases remain append-only and readable.
- Old validation cannot publish a changed draft; release build re-proves exact validation/draft identity.
- Publish/rollback move only expected-current pointer via owner action and append publication evidence.
- Existing Runtime sessions remain pinned to their exact release mechanics across later publish/rollback/reopen.
- Restore/clone/import do not rewrite or auto-publish immutable releases.

Result: **no blocker**.

### Publication UX and full author cycle — T21

- Studio Restore uses prepare/confirm with stable idempotency identity and stale-base fail-closed behavior.
- Release build is distinct from publication and cannot claim a release is published.
- Owner publish/rollback reports bind exact release/hash/current-pointer CAS; successful receipt gates publication wording.
- `apps/studio/test/b09-full-author-cycle.test.mjs` proves project → quest → authored edit → validation → frozen playtest → immutable release build → exact release report → explicit owner publish, without manual JSON.

Result: **T21 satisfied; no blocker**.

### Persisted playtest evidence

- Trace reader consumes persisted Runtime sessions/completed operations/turn boundaries for exact frozen-playtest release identity.
- Evidence is bounded and excludes guest credentials, idempotency/request-hash and fencing/lease material.
- Control derives the trace target from authoritative `FrozenPlaytestRecord`; client cannot select arbitrary release identity.
- Studio E2E proves frozen playtest → Runtime action → SQLite persistence → Control trace → Studio renderer without replaying gameplay/AI.
- UI explicitly distinguishes frozen playtest Runtime pin from published release.

Result: **no blocker**.

### Studio Access and server authority

- Current session/user and project role are displayed without secret token material.
- Owner member/role controls consume B09-01 APIs; last-owner/self constraints remain server-enforced.
- Editor/tester do not receive forbidden Access/publication controls, but hiding controls is not relied on for authorization.

Result: **no blocker**.

### Registry/generated endpoint truth

- Implemented history/compare/reference/restore/clone/export/import operations are available in endpoint registry/generated docs.
- The final implementation-only mismatch found during this audit — persisted playtest trace route implemented but not advertised — was corrected and generated contracts were regenerated with `docs:generate`/`docs:check` success.
- No B10 AI proposal/agent operation is advertised.

Result: **no blocker**.

## Evidence checkpoints

- Studio Restore — CI #460 success.
- Release build/exact report — CI #464 success.
- Owner publish/rollback — CI #469 success.
- persisted Runtime trace reader — CI #473 success.
- Control playtest trace route — CI #477 success.
- Studio persisted playtest evidence E2E — CI #481 success.
- Studio clone/export/import portability UX — CI #485 success.
- Studio dangerous deletion preflight UX — CI #489 success.
- T21 full author cycle — CI #491 success.
- T22 stale-editor conflict — CI #492 success.
- trace registry/generated-doc synchronization workflow `34166172838` — success.

T25 is covered by the canonical package/security/atomicity suites in `packages/control/test/lhquest-import-security.test.mjs`, `quest-import.test.mjs`, `quest-export.test.mjs` and `release-export.test.mjs`, all exercised by root verification checkpoints above.

## Result

- BLOCKER: **0**
- HIGH: **0**
- unresolved acceptance gap: **0**
- Publication Gate process steps remaining: final closure-doc current-head root CI → PR #33 ready → pinned merge at exact head → exact merge-SHA push-to-main CI success.

B09-03 is **functionally accepted**, but is **not called published** until those mechanical Publication Gate steps complete.
