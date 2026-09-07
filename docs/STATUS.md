# Статус движка

Последнее обновление: 2026-09-07.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B08 + B09-01 published; B09-02 functional accepted, Publication Gate in progress** | B09-01 merge `206ae32e1ce9f4a027c881e61d8e6e2163a4095d`, main CI `34135325041`; B09-02 generated-contract head `20bb2fc2be046abb04b77b838cf94692cabc51c7`, CI `34147022847` success |
| Контракты/Core | **B01–B03 published** | deterministic gameplay authority |
| Runtime storage/API | **B04 published + B09-02 published-release composition accepted** | published sessions pin exact release identity and execution context |
| Authoring / Control | **B05 published + B09-01 published + B09-02 release authority accepted** | draft → validation → immutable release → owner publish/rollback |
| AI foundation | **B06 published** | provider/intent/narrator/AgentBackend boundary; canonical BLOCKER=0 |
| Presentation/assets/Player | **B07 published** | immutable assets + executor + Runtime/browser integration |
| Plugins | **B08 published** | trusted manifest/registry/execution + artifact-bound `dice-check`; canonical BLOCKER=0 |
| Auth/publish | **B09-01 published; B09-02 accepted, not yet published** | final docs/current-head CI → ready PR #32 → pinned merge → exact main CI; then B09-03 |
| Author AI helper | не начато | B10 |
| Florence migration | не начато | B11 |
| Release hardening | не начато | B12 |

## B09-02 accepted behavior

- immutable Memory/SQLite release records bind exact project/quest/release, draft revision/hash, validation and compiled artifact hash;
- canonical compiled artifact SHA-256 is recomputed before release persistence;
- B08 plugin requirements and supported authored sidecars are persisted and re-preflighted;
- explicit valid empty plugin requirements sidecar is stored when no plugin is required;
- release build is owner/editor; tester cannot build;
- publish/rollback are owner-only, idempotent and expected-current compare-and-set;
- publish/rollback move only durable `currentReleaseId`; release content and existing Runtime state are unchanged;
- rollback can target only a previously published release;
- append-only publication events distinguish build/publish/rollback history;
- Control release list/build/publish/rollback HTTP routes preserve B09-01 auth/Origin/CORS/CSRF policy;
- new Runtime sessions resolve the exact current published release and re-run release/plugin preflight;
- every existing published session executes from its durable exact pinned release rather than current pointer;
- publishing v2 affects only later sessions; rollback affects only later sessions;
- production server composition uses SQLite published release resolver/bindings and has no silent static `minimal-paint` fallback;
- missing/corrupt/incompatible published content fails explicitly instead of selecting another release/plugin version;
- SQLite reopen preserves release pointer, session binding and continued exact pinned execution;
- generated agent/OpenAPI registry truthfully exposes exactly four B09-02 release operations and no B09-03 operations.

Semantic audit: `docs/audits/2026-09-07-b09-02-semantic-audit.md` → unresolved BLOCKER **0**.

## B09-02 Publication Gate

B09-02 is **not called published yet**. Remaining:

1. full CI on the final ADR/worklog/STATUS/HANDOFF current head;
2. update PR #32 with final evidence;
3. mark PR ready;
4. merge pinned to exact final head SHA;
5. verify exact merge-SHA `event=push`, `head_branch=main` CI success;
6. only then call B09-02 published and create B09-03 exactly from that verified merge SHA.

Weighted first-release estimate at this checkpoint: roughly **88–89%**. B12 remains the first-release closure; B13 remains a post-release Builder/deployment expansion.
