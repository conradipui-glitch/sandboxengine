# Передача работы

Обновлено: 2026-09-08

Текущий блок: **B09-03 — version history, portability and completed Studio author cycle**  
База: published B09-02 merge `5b4499e348432b7fb67c0294811c024250f1f634`  
B09-02 main CI: `34149100136` — success  
Ветка: `b09-03-version-history-studio-access`  
PR: #33  
Статус: **functional accepted; canonical B09 BLOCKER=0/HIGH=0; final current-head Publication Gate next**

## Published foundation

B01–B08, B09-01 and B09-02 are published. B09-02 canonical merge/base for this branch is `5b4499e348432b7fb67c0294811c024250f1f634`, exact main push CI `34149100136` success.

## What B09-03 now provides

- durable draft history over immutable revision snapshots;
- deterministic compare and visible stale-editor conflicts, with no automatic merge;
- restore-old-as-new-revision with stale-base CAS and idempotency;
- typed reference/deletion preflight sharing semantics with actual deletion recheck;
- independent quest clone with deterministic authored ID/reference remap;
- exact deterministic `.lhquest.zip` draft/release export, secret/player-state exclusion and hashes;
- hostile-input bounded atomic/idempotent import into a new unpublished draft;
- Studio Versions surface over real history/releases/current pointer;
- Studio Access over B09-01 session/member/role APIs;
- exact release build report separated from explicit owner publish/rollback receipt;
- persisted frozen-playtest evidence from Runtime sessions/completed operations/turns, never AI/gameplay reconstruction;
- Studio clone/export/import and dangerous deletion UX over real server contracts;
- endpoint registry/OpenAPI/agent generated truth synchronized with implemented B09-03 routes.

## Acceptance evidence

- Studio Restore — CI #460 success;
- immutable release build + exact report — CI #464 success;
- owner publish/rollback — CI #469 success;
- persisted Runtime trace reader — CI #473 success;
- Control playtest trace route — CI #477 success;
- Studio playtest evidence E2E — CI #481 success;
- Studio portability UX — CI #485 success;
- Studio deletion/reference UX — CI #489 success;
- T21 full author path — CI #491 success;
- T22 stale-editor conflict — CI #492 success;
- T25 hostile archive/exact portability is covered by canonical Control package/security/atomicity suites included in root verify;
- playtest trace registry/generated-doc sync workflow `34166172838` — success.

Canonical audit: `docs/audits/2026-09-08-b09-canonical-semantic-audit.md` → unresolved BLOCKER **0**, HIGH **0**.  
ADR: `docs/decisions/0031-server-authoritative-author-lifecycle-portability.md`.  
Task: `docs/tasks/B09-03-version-history-studio-access.md`.

## Important boundaries to preserve

- Studio/browser is never revision/reference/archive/gameplay/publication authority.
- Restore creates a new revision; it never rewinds history.
- A green deletion preflight is not an authorization token; mutation rechecks current server references.
- Clone/import create new draft identity and never rewrite source releases/playtests or auto-publish.
- `.lhquest.zip` is inert authored data, not executable content or project/session backup.
- Frozen playtest trace is persisted evidence and is distinct from a published release.
- Release build does not publish. Publish/rollback are explicit owner-only exact-current CAS operations.
- Existing Runtime sessions stay pinned to exact release mechanics across publish/rollback.
- B10 must use these Control contracts rather than adding an agent bypass around Studio/server authority.

## Exact next sequence

1. finish the B09-03 worklog/closure docs on this branch;
2. fetch the resulting **exact current PR head** and require its ordinary root CI success (`npm run verify`, including deterministic `docs:check`);
3. update PR #33 body with canonical audit + final CI evidence;
4. ensure there is no unresolved blocking review state and mark PR ready;
5. merge using the exact pinned current head SHA — do not merge a moved head;
6. fetch the exact workflow with `event=push`, `head_branch=main`, `head_sha=<merge SHA>` and require success;
7. only then call **B09-03 and canonical B09 published**;
8. start **B10 — interactive author assistant, Skills/MCP broker and Codex adapter** exactly from that verified B09-03 merge SHA.

Do not start B10 from the feature branch, a pre-closure SHA or an unverified main ref.
