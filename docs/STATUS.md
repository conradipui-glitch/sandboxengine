# Статус движка

Последнее обновление: 2026-09-07.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B07-02 published; B07-03 functional gate green на PR #26** | B07-02 merge `b6b9c1c61580f184114e7e49b3a16b02bb0e02a8`, main CI `34092343539`; B07-03 hardening head `6ee2820b…`, CI `34095824094` success → docs/current-head gate → pinned merge/main CI |
| Контракты/Core | **B01–B03 published** | deterministic gameplay authority |
| Runtime storage/API | **B04 published** | idempotency/fencing/SQLite/guest HTTP |
| Authoring / Control | **B05 published** | draft → validation → frozen playtest → Player |
| AI foundation | **B06 published** | provider/intent/narrator/AgentBackend boundary; canonical audit BLOCKER=0 |
| Presentation contracts | **B07-01 published** | `SceneFrameV2`, bounded `PresentationPlanV2`, immutable refs/convergence |
| Asset ingestion/storage | **B07-02 published** | trusted bytes → metadata/hash → immutable object/registry → exact read; merge `b6b9c1c6…`, main CI `34092343539` |
| Player presentation executor | **B07-03 accepted functionally** | pure executor, sequence/parallel, skip/reduced-motion, reload/replay safety, media fallback; CI `34095824094`; ADR 0024 |
| Runtime/browser presentation wiring | не начато | B07-04 after B07-03 publication, then final B07 audit/closure |
| Plugins | не начато | B08 |
| Auth/publish | не начато | B09 |
| Author AI helper | не начато | B10 |
| Florence migration | не начато | B11 |

## Published B07 foundation

B07-01 publication: merge `b52b3ee8fe8d890c22b62f1b6ebd27cda7fda2c4`, main CI `34083673425`.

B07-02 publication: merge `b6b9c1c61580f184114e7e49b3a16b02bb0e02a8`, main CI `34092343539`.

The published foundation now provides:

- final reload-safe presentation state (`SceneFrameV2`);
- bounded non-executable one-turn transition (`PresentationPlanV2`);
- immutable `assetId + SHA-256` identity;
- trusted bounded asset ingestion/storage/read boundary.

## B07-03 — Player presentation executor

Branch: `b07-03-player-presentation-executor`.  
PR: #26.  
Task: [B07-03](tasks/B07-03-player-presentation-executor.md).  
Decision: [ADR 0024](decisions/0024-player-presentation-executor-authority.md).  
Worklog: [2026-09-07 B07-03](worklog/2026-09-07-b07-03.md).

### Functional behavior

- `SceneFrameV2` remains authoritative final presentation state;
- plan preflight happens before any command delivery;
- sequence is ordered, parallel starts siblings together;
- skip/reduced-motion converge directly to target frame;
- media/renderer failure converges to target frame without gameplay replay;
- duplicate/reload/stale/conflict/gap never synthesize missing gameplay transitions;
- confirmed dialogue history comes from the frame, not transient bubbles;
- presentation cancellation cannot rollback committed gameplay;
- generation guards prevent slow superseded restore/playback from overwriting a newer frame;
- runtime objects cannot widen the canonical per-command duration bound.

### Evidence

- first executor head `e2cfaf94d546e1436c396b664d2480360d52cae8` → CI `34095614169` success;
- hardening head `6ee2820bf7abcecd7a7c7108e60d4fd07a346dfb` → CI `34095824094` success;
- unresolved functional BLOCKER: **0**.

## Publication Gate B07-03

Remaining:

1. final current-head CI after ADR/STATUS/HANDOFF/worklog sync;
2. mark PR #26 ready;
3. pinned merge at exact expected head;
4. exact merge-SHA push-to-main CI;
5. only then call B07-03 published.

After that: **B07-04 Runtime/HTTP + minimal browser presentation integration/E2E**, followed by final B07 audit/closure before B08.

## Overall roadmap orientation

Weighted implementation estimate: roughly **70% complete** before B07-03 publication. Architectural foundation is substantially further along than the remaining user-facing/product integration layers.
