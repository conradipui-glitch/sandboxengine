# B09-02 — immutable release build, publish and rollback

## Goal

Turn a successfully validated exact quest snapshot into an immutable release, let only a project owner atomically select a compatible release as `currentReleaseId`, support safe rollback to a previously published release, and make new Runtime sessions start from that published release without moving existing sessions.

Base: published B09-01 merge `206ae32e1ce9f4a027c881e61d8e6e2163a4095d`, exact `main` push CI `34135325041` — success.

Specification sources: §15.2–15.3, §16.1–16.3, B09 card in §19, published B08 artifact compatibility/sidecar gates.

## Main invariant

**A release is immutable content identified by one exact compiled artifact hash. Publish and rollback never rewrite release content; they atomically move only the quest's `currentReleaseId`. Every publish and every new-session start re-proves compatibility against the exact stored release hash and installed plugin build. Existing sessions remain permanently pinned to the release with which they were created.**

## Architecture

Do not modify `QuestRelease` v1 or make Core own publication metadata.

B09-02 adds an authoring/control release envelope around the already canonical `CompiledQuestArtifact`:

- project/quest/release identity;
- exact draft revision/content hash;
- exact successful validation identity;
- exact `compiledContentHash` (`sha256` of canonical compiled artifact);
- immutable compiled artifact;
- immutable B08 plugin requirement/authored sidecar data bound to that same artifact hash;
- publication metadata/history separate from release content.

Core still receives only canonical gameplay contracts. Runtime still stores a `PinnedReleaseIdentity` inside each session. Composition between Control publication and Runtime session bootstrap belongs outside Core.

## Do

### 1. Immutable release storage contract

Extend Control storage with Memory + SQLite parity for release lifecycle.

A release record must contain enough data to prove, after restart, exactly what was validated and what Runtime may start. At minimum:

- `releaseId`, `projectId`, `questId`;
- source `draftRevision`, source draft `contentHash`;
- `validationId`;
- immutable `CompiledQuestArtifact`;
- exact `compiledContentHash` + algorithm `sha256`;
- canonical persisted plugin sidecars required by this build;
- creation identity/time only if they are service metadata and never part of gameplay hash.

Rules:

- release content is append-only/immutable;
- same release ID cannot later point at another hash/content;
- old releases remain readable after later build/publish/rollback;
- SQLite release rows survive reopen;
- no destructive release GC in this slice;
- malformed/corrupt stored release fails closed instead of being repaired from current draft.

### 2. Release build gate

`POST Q/releases` builds a release only from an exact successful validation.

Required checks before persistence:

1. project/quest/revision exist;
2. validation exists, belongs to same project/quest/revision and is `valid`;
3. validation draft `contentHash` equals the exact source snapshot hash;
4. validation compiled artifact/hash are present;
5. recomputing canonical compiled artifact SHA-256 equals the validation `compiledContentHash`;
6. supplied/persisted B08 plugin sidecars are valid and bound to exactly that compiled hash;
7. installed plugin requirements are currently satisfiable;
8. any plugin-specific authored binding used by this build (currently `dice-check`) materializes only after exact artifact-hash match.

A later draft edit must never let an old validation certify the changed revision/hash.

Owner/editor may build a release; tester may not. Build uses an `Idempotency-Key` and repeated identical requests return the same stored result; key reuse with different request identity is a conflict.

### 3. Persist B08 sidecars without inventing another compatibility system

Reuse published B08 gates:

- `PluginArtifactRequirementsSidecar` + `preflightPluginArtifactRequirements`;
- exact authored sidecar binding for installed proof mechanics such as `DiceCheckAuthoredSidecar` + `bindDiceCheckRegistrationToArtifact`.

Do not duplicate plugin version arithmetic in Control or Runtime.

The persisted release must contain the exact sidecar data needed to re-run compatibility after restart. The release hash binding is always the compiled artifact hash already stored on the release.

If a release has no plugin requirements, persist an explicit valid empty-requirements sidecar rather than treating missing compatibility metadata as success.

### 4. Atomic current-release pointer

Each quest gets a durable nullable `currentReleaseId`.

Publish:

- owner only;
- release must belong to this project/quest;
- release integrity and plugin preflight are re-checked immediately before pointer movement;
- pointer update is atomic;
- publish is idempotent;
- republishing the already-current same release is a safe replay/no-op, not a new release;
- failed preflight never changes the pointer.

Release content is never mutated by publication.

### 5. Rollback semantics

Rollback is owner only and is **pointer rollback**, never state rollback.

- body identifies target prior release and `expectedCurrentReleaseId`;
- target must belong to this quest and must have been successfully published before (not merely built and never released);
- exact release integrity/plugin preflight runs again;
- pointer change is atomic and compare-and-set against expected current release;
- stale expected pointer returns conflict;
- rollback is idempotent for the same request identity;
- no player session/world state is changed or downgraded;
- DB/schema downgrade is not performed.

### 6. Publication history / proof

Persist enough immutable publication events to distinguish:

- built but never published release;
- initially published release;
- later publish of another release;
- rollback to a previously published release.

History is append-only service metadata. B09-03 may add richer author-facing version UX, but B09-02 must already make rollback eligibility and auditability unambiguous.

### 7. HTTP Control routes

Implement and only then advertise:

- `POST Q/releases` — owner/editor build from exact validation;
- `GET Q/releases` — project member reads immutable release summaries + current pointer/publication status;
- `POST Q/publish` — owner-only current pointer change;
- `POST Q/rollback` — owner-only compare-and-set rollback.

All authenticated mutations keep B09-01 session/Origin/CSRF policy. Publish/rollback never trust browser-side role state.

Use bounded exact request shapes. Do not return plugin credentials, session secrets or hidden author-only data in public Runtime responses.

### 8. Runtime published-release bootstrap

Replace the production/static-template assumption with an injected published-release resolver/catalog at the server-composition boundary.

Requirements:

- new session resolves the quest's current published release at session creation time;
- release integrity and B08 plugin compatibility are re-checked before creating the session;
- Runtime receives a frozen template/initial state derived from that exact immutable compiled artifact;
- `SessionRecord.release` pins exact release identity forever;
- publishing v2 affects only later sessions;
- rollback affects only later sessions;
- existing sessions continue through their pinned release even if pointer changes;
- if current release becomes unavailable/incompatible with installed build, new session creation fails explicitly and does not silently select another release;
- dev fixture/static template may remain for isolated tests/local demos, but must be explicit and must not masquerade as production published-release resolution.

Do not make `@living-history/runtime` depend on `@living-history/control`. Compose Control release storage + plugin preflight + Runtime bootstrap in the server/application boundary.

### 9. Startup/restart compatibility

On standalone server startup, published-release resolution must still work after SQLite reopen.

At minimum, a release selected before restart must be readable and preflightable after restart. Missing/incompatible installed plugin data must block new starts explicitly; it must not rewrite `currentReleaseId` or mutate stored release.

### 10. Registry/generated docs

Only after routes exist:

- mark release build/list/publish/rollback available;
- generated OpenAPI/capabilities must include them;
- publish/rollback summaries must state owner-only semantics;
- do not advertise B09-03 history/import/export/restore UI operations early;
- `docs:check` deterministic.

## Required regressions

1. exact valid validation builds one immutable release;
2. invalid validation cannot build release;
3. validation for another revision/hash cannot certify changed draft;
4. canonical artifact hash is recomputed and mismatch fails before persistence;
5. release ID/content is immutable;
6. Memory and SQLite build semantics match;
7. SQLite releases/current pointer/publication history survive reopen;
8. release build idempotency replay returns same release; key reuse with changed request conflicts;
9. empty plugin requirements are explicit valid sidecar, not missing metadata;
10. plugin sidecar artifact hash mismatch blocks build;
11. missing/incompatible installed plugin blocks build/publish/start with explicit reason;
12. invalid authored `dice-check` sidecar cannot materialize a production release registration;
13. editor may build release but cannot publish/rollback;
14. tester cannot build/publish/rollback;
15. owner can publish compatible release;
16. publish failure never moves pointer;
17. two competing pointer changes cannot both win stale compare-and-set semantics where expected pointer applies;
18. built-never-published release cannot be rollback target;
19. rollback to previously published release succeeds only with matching expected current pointer;
20. stale rollback expected pointer returns conflict and preserves pointer;
21. old release remains byte/content-equivalent after later releases;
22. new session after v1 publish pins v1;
23. publish v2 creates new session on v2 while existing v1 session stays v1;
24. rollback to v1 makes subsequent new session v1 while existing v2 session stays v2;
25. server restart preserves pointer and release startability;
26. corrupt stored release or failed compatibility never silently falls back to another release;
27. Runtime guest auth remains independent from Control owner auth;
28. root `npm run verify` green and generated docs current.

## Functional acceptance

B09-02 is accepted when:

1. immutable release identity is proven from exact successful validation/hash;
2. B08 sidecars are persisted and enforced at build, publish and new-session start;
3. owner-only publish/rollback atomically moves only `currentReleaseId`;
4. rollback can target only a previously published release and uses expected-current compare-and-set;
5. existing sessions never migrate when publish/rollback occurs;
6. SQLite restart preserves releases/history/current pointer;
7. no production path silently substitutes static template/current draft/another plugin version when published release resolution fails;
8. available endpoint registry truthfully exposes implemented release operations only;
9. semantic audit has zero unresolved BLOCKER.

## Not now

- B09-03 draft restore/history UI, clone/import/export, deletion/reference UX;
- final Studio Versions/Access screens and visible owner publish report UX (B09-03 consumes this server contract);
- public signup/invites/password reset;
- plugin marketplace/dynamic code loading;
- arbitrary old runtime-code loading or live save migration;
- destructive release garbage collection;
- B10 author AI jobs;
- B11 Florence migration;
- B12 release candidate/ops drill.

## Next

After verified published B09-02: **B09-03 — draft/version history, clone/import/export, references/deletion UX, Studio Versions/Access surfaces and canonical B09 audit**, exactly from the verified B09-02 merge SHA.