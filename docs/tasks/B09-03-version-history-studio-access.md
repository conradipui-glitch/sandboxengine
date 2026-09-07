# B09-03 — version history, portability and completed Studio author cycle

## Goal

Finish the remaining B09 authoring lifecycle on top of published B09-01 identity/roles and published B09-02 immutable releases: make draft history/restoration, conflict comparison, safe clone/import/export, reference/deletion checks, author-visible playtest/publication evidence and Studio Versions/Access surfaces complete enough that an editor can create, revise, test and hand an owner a visible publish report without editing JSON or trusting browser-side authority.

Base: published B09-02 merge `5b4499e348432b7fb67c0294811c024250f1f634`, exact `main` push CI `34149100136` — success.

Specification sources: §6 authoring references/portability, §11 Studio persistence/playtest UX, §15.2 Control API, §16 security/portability boundaries, B09 card in §19, acceptance T17–18/T21–22/T25.

## Main invariant

**History, restore, clone, import/export and Studio UX may create or select authoring data, but they never rewrite an existing immutable release, never bypass project roles/CSRF, never silently overwrite a newer draft revision, never export secrets/runtime/player state, and never publish on behalf of the owner. Publication remains an explicit owner action against an exact validated release.**

## Architecture

Keep the authority split already published:

- `@living-history/control` owns durable authoring/history/reference/portability data contracts;
- `apps/server` owns authenticated HTTP policy, bounded archive parsing/serialization and composition;
- `apps/studio` is a browser client of Control and does not become an authority source;
- `@living-history/runtime` and Core are unchanged by draft history/import/export;
- immutable B09-02 release rows/history remain append-only.

Execute this B09-03 card in bounded sequential slices on one branch/PR:

1. version history + restore/conflict/reference primitives;
2. clone + export/import portability;
3. Studio Versions/Access + visible publish/playtest/conflict UX;
4. canonical B09 semantic audit/docs closure.

Do not start UI by faking unavailable server operations. Server contracts and regressions land first.

## Do

### 1. Draft history read contract

Expose durable revision history from existing immutable draft snapshots instead of adding a second history store.

At minimum each history entry exposes safe author metadata already known by Control:

- projectId / questId;
- draftRevision;
- contentHash;
- title;
- enough deterministic summary to compare revisions without returning secrets.

Rules:

- oldest revisions remain readable after later edits;
- Memory and SQLite semantics match;
- history order is deterministic;
- project rights apply server-side;
- history read must not mutate current revision.

Implement a Control route only when backed by the real store, for example `GET Q/draft/history`.

### 2. Restore old draft as a new revision

Implement canonical `POST Q/draft/restore` from §15.2.

Input must identify:

- `sourceRevision` to copy;
- `baseRevision` expected to still be current;
- idempotency key if the service operation can be replayed.

Semantics:

- restore never rewinds/deletes history;
- it creates a **new** current revision with the old snapshot content;
- the new revision gets its own revision number/hash according to canonical draft rules;
- stale `baseRevision` returns conflict and does not overwrite another editor;
- restoring an invalid/missing source fails without mutation;
- validations/releases/playtests previously bound to old revisions remain immutable records and are not retargeted.

### 3. Conflict comparison support

T22 requires a human-visible conflict rather than silent overwrite.

Provide enough server data for Studio to compare:

- client's stale base revision;
- current server revision;
- deterministic changed-block/title summary between two stored revisions;
- no automatic merge in B09-03.

A conflict response or dedicated read service may expose this comparison, but the browser must never guess server truth from its local copy.

### 4. Reference and deletion safety

Preserve the existing invariant that a referenced block cannot be deleted, and make the dependency reason author-visible.

Add a deterministic reference analysis service for draft content that reports at least:

- target block ID;
- referring block IDs;
- referring field/path or typed relation;
- whether deletion is currently safe.

Rules:

- deletion preflight and actual mutation must share the same semantic reference logic;
- actual `block.remove` still rechecks on authoritative current draft even if the browser preflight was green;
- missing/duplicate/invalid refs fail closed;
- no arbitrary JSONPath/eval/query language.

### 5. Quest clone

Implement a project-scoped clone operation for an existing quest/draft.

Requirements:

- owner/editor only; tester cannot clone;
- creates a new quest/draft, never aliases source mutable state;
- caller supplies bounded new `questId` and title;
- duplicated authored block IDs are remapped to fresh deterministic IDs and all internal references are rewritten consistently;
- external dependencies, if any, are preserved only as explicit dependency records and must validate;
- source quest history/releases/playtests remain unchanged;
- clone is idempotent for the same request identity and conflicts on key reuse with different input.

If current canonical contracts cannot represent an external dependency safely, fail closed rather than inventing one.

### 6. `.lhquest.zip` export

Implement `GET Q/export` only after the package format is explicit and tested.

The package is inert data, never executable code. At minimum include:

- manifest with format/schema version;
- selected exact draft revision **or** exact immutable release identity;
- canonical quest/block data required to reconstruct a new draft;
- referenced portable asset manifests/objects only when they are part of the selected authored package and can be proven by exact hash;
- required plugin compatibility metadata needed to validate the authored package;
- SHA-256 hashes for package files.

Must exclude:

- provider/API keys and credential references that reveal secrets;
- Control session/CSRF secrets/password material;
- Runtime guest credentials, player sessions/world saves/turn history;
- private provider prompts/logs or unrelated project data;
- arbitrary executable files.

Exporting a release does not mutate/rebuild it and does not imply that release is current.

### 7. Safe import into a new draft

Implement `POST /control/v1/projects/{projectId}/imports`.

Import is owner/editor only and creates a **new quest draft**; it never publishes automatically.

Archive parser must be bounded and fail closed on at least:

- absolute paths, `..` traversal, NUL/path ambiguity and duplicate normalized paths;
- excessive compressed size, excessive uncompressed size, excessive file count and per-file bounds;
- unsupported package/schema version;
- missing/duplicate manifest entries or hash mismatch;
- disallowed MIME/file type;
- unknown/incompatible required plugin/schema;
- invalid quest/block references;
- embedded executable/script/HTML/SVG content where not explicitly permitted;
- secret-shaped forbidden package sections.

Do not extract untrusted paths directly to a host filesystem. Prefer bounded in-memory/stream inspection or a private temp root with validated normalized names and no symlink following.

After validation, create the destination quest/draft atomically with a new caller-supplied quest identity. Failed import leaves no partial project/quest/assets.

Import uses an idempotency key; identical retry returns the same created draft, changed request identity conflicts.

### 8. Assets and deletion/reference UX

If portable assets are included:

- verify their real bytes with the published B07-02 ingestion boundary;
- preserve exact content hashes;
- do not substitute another version with same assetId;
- do not delete an object used by an immutable release;
- import failure must not leave half-registered logical asset records.

If full asset transactionality cannot be safely completed in this slice, export/import quest metadata without pretending embedded assets were imported; surface missing asset dependencies explicitly.

### 9. Completed playtest trace/read evidence

B09 author flow needs a visible report before owner publication.

Expose/read enough immutable playtest evidence for Studio to show:

- exact playtest ID, draft revision/hash, validation identity;
- exact pinned compiled/release-compatible identity used by the playtest;
- completed actions/turn outcomes available from persisted Runtime operation/turn records when the playtest is launched through the existing bridge;
- clear distinction between a frozen playtest snapshot and a published release.

Do not reconstruct a historical trace by rerunning AI or gameplay.

### 10. Studio Versions screen

Build a real human UI over implemented server routes. Minimum:

- current draft revision + save state;
- revision history list;
- compare/conflict view for stale edits;
- restore old revision as a new revision;
- immutable release list with hashes/status/current pointer;
- visible validation/playtest status;
- owner publish report that states exactly which revision/hash/release will become current;
- owner publish and rollback controls only when server session role permits, while server remains authoritative;
- editor can build/inspect but UI explains why publish is owner-only;
- tester is read/test only;
- no UI statement `Опубликовано` until a successful server publication receipt is returned.

### 11. Studio Access screen

Consume published B09-01 member/session APIs:

- show current user/session safely;
- list project members/roles for owner;
- owner can set/remove roles subject to last-owner protection;
- editor/tester see their role and permissions without receiving forbidden mutation controls;
- no secret/session token display;
- browser role state is presentation only, never an authorization source.

No public signup/invite workflow is added.

### 12. Studio portability/conflict UX

Provide bounded author-facing flows for:

- clone quest;
- export selected draft/release;
- import `.lhquest.zip` into a new draft;
- show missing/incompatible dependency errors with concrete cause;
- dangerous deletion preflight showing references;
- stale save/restore conflict showing current vs base revisions and changed objects.

A correct failure message is preferred over an unsafe automatic repair/merge.

### 13. Registry/generated docs

Only after operations exist, mark them `available` and regenerate agent/OpenAPI docs.

Expected B09-03 operations may include the implemented subset of:

- `GET Q/draft/history`;
- `POST Q/draft/restore`;
- reference/deletion preflight route if one is introduced;
- quest clone route;
- `GET Q/export`;
- `POST /control/v1/projects/{projectId}/imports`;
- any playtest/trace read route actually implemented.

Do not advertise B10 AI proposal/agent operations or unsupported B09-03 UI-only actions as HTTP endpoints.

### 14. Canonical B09 audit and closure

After the first all-green implementation, perform a semantic hardening audit across **B09-01 + B09-02 + B09-03**.

Explicitly recheck:

- server-side owner/editor/tester matrix;
- CSRF/Origin/CORS on every new mutation;
- old validation cannot publish changed draft;
- old releases remain immutable/readable;
- existing Runtime sessions never migrate on publish/rollback;
- history restore creates a new draft revision rather than rewriting history;
- conflicts never silently overwrite;
- clone/import remap identities/references correctly;
- T25 traversal/size/secret cases;
- export contains no credentials/player state;
- Studio can complete T21 without manual JSON;
- Studio conflict UX covers T22;
- endpoint/generated docs truth;
- no unresolved BLOCKER before Publication Gate.

Record ADR/worklog/audit/STATUS/HANDOFF and use the normal pinned-head Publication Gate.

## Required regressions

1. Memory/SQLite draft history parity and deterministic order;
2. old draft snapshots remain byte/content-equivalent after later edits;
3. restore creates new revision and does not alter source history;
4. stale restore/base revision conflicts without mutation;
5. comparison identifies title/block add/replace/remove differences deterministically;
6. reference analysis identifies concrete referring block/field;
7. referenced block deletion remains impossible even after stale green preflight;
8. safe unreferenced deletion still succeeds;
9. clone creates independent quest and remaps internal block references;
10. clone retry is idempotent; key reuse with changed input conflicts;
11. tester cannot clone/import/restore/mutate;
12. valid `.lhquest.zip` export/import reconstructs equivalent authored quest in a new draft;
13. export of draft is bound to selected exact revision/hash;
14. export of release is bound to exact immutable release/hash and does not move current pointer;
15. export contains no Control/provider/Runtime/player secrets or state;
16. import rejects `../`, absolute path, normalized duplicate, NUL and symlink-like archive attacks;
17. import rejects oversized compressed/unpacked package, too many files and oversized member;
18. import rejects manifest/file SHA-256 mismatch;
19. import rejects unknown/incompatible schema/plugin requirement;
20. failed import is atomic and creates no partial quest/assets;
21. import never publishes automatically;
22. import identical retry returns same draft; changed request on same idempotency key conflicts;
23. release/session behavior from B09-02 remains unchanged;
24. B09-01 role/CSRF/CORS regressions remain green;
25. Studio Versions renders real history/releases/current pointer and owner-only publish report;
26. Studio Access reflects real server role/member data without secrets;
27. T21 full author path works without manual JSON;
28. T22 stale editor conflict is visible and never silently overwritten;
29. T25 good package transfers; malicious/secret package fails;
30. root `npm run verify` and deterministic `docs:check` green.

## Functional acceptance

B09-03 is accepted when:

1. history/restore/conflict/reference operations are durable and server-authoritative;
2. clone/import/export are portable, bounded, secret-free and fail closed;
3. no import/restore/clone operation can mutate existing immutable releases or auto-publish;
4. Studio exposes usable Versions and Access surfaces over real APIs;
5. owner sees an exact publish report and publication occurs only after explicit owner action;
6. T21/T22/T25 are demonstrated through deterministic tests/E2E appropriate to the current app;
7. canonical B09 audit across B09-01/02/03 has unresolved BLOCKER **0**;
8. generated endpoint/docs truth matches implemented operations;
9. final current-head CI, pinned merge and exact main push CI complete before calling B09 published.

## Not now

- live collaborative editor/CRDT;
- public signup, email invitations, password reset or enterprise IAM/SSO;
- B10 AuthoringProposal/chat/agent job implementation;
- B13 Builder/GitHub/deployment runner;
- marketplace/dynamic plugin loading;
- arbitrary ZIP extraction or executable import;
- destructive release garbage collection;
- live migration of existing Runtime sessions to another release;
- automatic three-way merge of conflicting drafts;
- Florence migration (B11);
- production backup/restore drill (B12).

## Next

After verified published B09-03 and canonical B09 closure: **B10 — interactive author assistant, Skills/MCP broker and Codex adapter**, exactly from the verified B09-03 merge SHA.