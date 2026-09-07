# ADR 0031 — server-authoritative author lifecycle and inert portability

Status: Accepted

Date: 2026-09-08

## Context

B09-01 established authenticated Control sessions/project roles and B09-02 established immutable release build/publication with Runtime sessions pinned to exact release identity. B09-03 must complete the human author lifecycle without weakening either boundary: history and restore, conflict/deletion safety, clone/export/import portability, persisted playtest evidence, and Studio Versions/Access/publication UX.

The central risk is authority drift. A browser can display authoring state but must not become the source of truth for revision history, references, archive compatibility, release identity, gameplay evidence or publication state. Likewise, portability must not turn a quest package into an executable/import-anything boundary.

## Decision

### 1. Draft history reuses immutable Control snapshots

Draft revisions are the canonical history. No second mutable history store is introduced.

History/compare/reference reads operate on exact stored revisions. Restore copies an old snapshot into a **new** current revision using expected-current compare-and-set and idempotency. It never rewinds, deletes or retargets old revisions, validations, playtests or releases.

### 2. Conflicts and dangerous deletion fail closed on server truth

Stale draft mutation/restore returns an explicit revision conflict; Studio may show deterministic server comparison data but performs no automatic three-way merge.

Deletion preflight uses the same typed reference semantics as authoritative `block.remove`. A green browser preflight is informational only: actual mutation rechecks the current server draft, so a stale green result cannot authorize deletion after new references appear.

### 3. Clone and import create new authoring identity only

Clone/import are owner/editor mutations protected by project roles, CSRF and idempotency. They create new quest drafts and never alias mutable source state, rewrite source history/releases/playtests or publish automatically.

Clone remaps authored block IDs deterministically and rewrites only canonical typed internal references. Unsupported/external dependency shapes fail closed rather than being guessed.

### 4. `.lhquest.zip` is inert, bounded, exact-identity data

Export is bound to exactly one selected draft revision or immutable release identity. The server produces deterministic inert archive data with explicit format/schema metadata and SHA-256 file hashes. It excludes Control/provider credentials, sessions, CSRF/password material, Runtime guest credentials/player state/turn history and unrelated project data.

Import treats the archive as hostile input. Path traversal/absolute/NUL/normalized duplicate/symlink-like entries, unsupported compression/types/schema/plugins, size/file-count/member bounds, hash mismatch, invalid references, executable content and forbidden secret-shaped sections fail closed. Validation occurs before atomic new-draft creation; failed import leaves no partial quest/assets and does not publish.

Studio does not parse or reinterpret the archive. It downloads the exact server export envelope and sends the selected archive to the bounded server import parser.

### 5. Playtest evidence is read from persisted Runtime facts, never reconstructed

Frozen playtest identity remains distinct from a published release. A read-only Runtime evidence adapter filters sessions by exact `questId + playtest-${playtestId} + contentHash` and returns only bounded persisted completed operation/turn evidence.

It does not expose guest credentials, idempotency keys, request hashes, lease/fencing state or verifier material and never reruns AI/gameplay to reconstruct history. Control derives the exact trace target from the authoritative frozen playtest record; the browser cannot choose an arbitrary release identity.

### 6. Studio is a presentation/client layer over real Control authority

Studio Versions/Access/portability/deletion/playtest surfaces consume implemented APIs. Browser role state controls presentation only; server roles/CSRF remain authoritative.

Release build and publication are intentionally separate:

`exact current draft + exact successful validation -> immutable release build -> exact owner publish/rollback report -> explicit owner mutation -> server receipt`

No UI text claims publication until a successful publication receipt. Publish/rollback use expected-current CAS and stable request identity; conflicts require a fresh report rather than silently retargeting the operation.

### 7. Generated endpoint truth follows implementation

Only implemented HTTP operations are marked `available`. Registry and generated OpenAPI/agent contracts are regenerated after server routes exist. UI-only actions are not advertised as new server operations.

## Consequences

- Authors can complete the B09 lifecycle without editing raw JSON while all safety-critical decisions remain server-side.
- Restore/clone/import are creation operations, not mutation shortcuts around immutable history/releases.
- Export/import can be used for portable authored content without becoming a secret/player-state or executable transport.
- Persisted playtest evidence remains auditable and cannot change when AI/gameplay implementation later changes.
- Studio can be replaced by another client without changing authoring/publication semantics.
- B10 author-assistant/agent work must use the same Control contracts rather than bypassing them.

## Rejected alternatives

- Browser-side history/merge/reference inference: rejected because stale local state is not authoritative.
- Restore by moving the current revision pointer backward: rejected because history/validation/playtest identity would cease to be immutable.
- Trusting a green deletion preflight as a capability token: rejected because references may change before mutation.
- Extracting arbitrary ZIP contents to the host filesystem: rejected because portability archives are hostile input.
- Exporting whole project databases/session state: rejected because quest portability is authored-content transfer, not backup or player migration.
- Replaying Runtime/AI to rebuild playtest history: rejected because historical evidence must come from persisted completed operations/turns.
- Publishing automatically after import/restore/release build: rejected because publication is an explicit owner decision against exact immutable content.
