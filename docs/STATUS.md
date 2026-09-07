# Статус движка

Последнее обновление: 2026-09-08.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B08 + B09-01 + B09-02 published; B09-03 functionally accepted, Publication Gate next** | B09-02 merge `5b4499e348432b7fb67c0294811c024250f1f634`, exact main push CI `34149100136` success; B09 canonical audit BLOCKER=0 |
| Контракты/Core | **B01–B03 published** | deterministic gameplay authority |
| Runtime storage/API | **B04 published + B09-02 pinned publication + B09-03 persisted playtest evidence accepted** | Runtime sessions stay pinned to exact release/playtest identity; historical evidence is read from persisted operations/turns |
| Authoring / Control | **B05 published + B09 accepted through B09-03 functional gate** | durable history/compare/restore/reference safety + clone/export/import + immutable release/publication authority |
| AI foundation | **B06 published** | provider/intent/narrator/AgentBackend boundary; canonical BLOCKER=0 |
| Presentation/assets/Player | **B07 published** | immutable assets + executor + Runtime/browser integration |
| Plugins | **B08 published** | trusted manifest/registry/execution + artifact-bound `dice-check`; canonical BLOCKER=0 |
| Auth/publish/Studio | **B09-01/02 published; B09-03 accepted, not yet published** | final current-head root CI → PR #33 ready → pinned merge → exact main push CI |
| Author AI helper | не начато | B10 after verified B09-03 publication |
| Florence migration | не начато | B11 |
| Release hardening | не начато | B12 |

## B09-03 accepted behavior

- existing immutable draft snapshots are the canonical durable version history;
- deterministic history/compare/reference reads are server-authoritative and non-mutating;
- restore copies an old snapshot into a **new** revision, is idempotent and rejects stale `baseRevision` without overwrite;
- T22 proves a real stale Studio client receives `409`, sees authoritative server diff and only an explicit retry against current revision creates a new revision;
- deletion preflight reports concrete typed references and actual `block.remove` always rechecks current server truth, so stale green preflight cannot authorize deletion;
- clone creates an independent new quest, deterministically remaps authored IDs/references and preserves source state;
- exact draft/release `.lhquest.zip` export is deterministic, hash-addressed and excludes Control/provider/Runtime/player secrets/state;
- import treats archives as hostile input, enforces traversal/path/compression/size/file-count/hash/schema/plugin/reference/executable/secret bounds, is atomic/idempotent and creates only a new unpublished draft;
- Studio portability is a thin client over those server contracts and does not implement a second ZIP parser;
- persisted playtest evidence reads exact frozen Runtime sessions/completed operations/turn boundaries without replaying gameplay/AI and without exposing guest credentials/idempotency/fencing material;
- Studio Versions shows real draft history/releases/current pointer, restore, release build, owner publication report and receipt-gated publish/rollback state;
- Studio Access consumes B09-01 session/member APIs; browser role state is presentation only;
- T21 proves the full Studio author path project → quest → edit → validation → frozen playtest → immutable release build → explicit owner publish without manual JSON;
- owner publication remains a separate exact CAS mutation and no restore/clone/import/release-build operation auto-publishes;
- endpoint registry/OpenAPI/generated agent docs now include every implemented B09-03 server operation, including persisted playtest trace, and do not advertise B10 operations.

Canonical audit: `docs/audits/2026-09-08-b09-canonical-semantic-audit.md` → unresolved BLOCKER **0**, HIGH **0**.  
ADR: `docs/decisions/0031-server-authoritative-author-lifecycle-portability.md`.

## Key B09-03 verification checkpoints

- Studio Restore — CI #460 success;
- release build/exact report — CI #464 success;
- owner publish/rollback — CI #469 success;
- Runtime persisted playtest trace — CI #473 success;
- Control trace HTTP — CI #477 success;
- Studio playtest evidence E2E — CI #481 success;
- Studio portability UX — CI #485 success;
- deletion/reference UX — CI #489 success;
- T21 full author cycle — CI #491 success;
- T22 stale editor conflict — CI #492 success;
- trace registry/generated docs synchronization workflow `34166172838` — success.

## B09-03 Publication Gate

B09-03 is **functionally accepted but not yet called published**. Remaining sequence:

1. complete closure ADR/audit/worklog/STATUS/HANDOFF and require root `npm run verify` on the exact final PR head;
2. update PR #33 with the final evidence and ensure no unresolved blocking review state;
3. mark PR ready;
4. merge pinned to that exact head SHA;
5. find the exact `event=push`, `head_branch=main` CI whose `head_sha` is the merge SHA and require success;
6. only then call B09-03/B09 published and start B10 from the verified main merge SHA.

B12 remains the first-release hardening/operational closure; B10 is the next implementation card after verified B09 publication.
