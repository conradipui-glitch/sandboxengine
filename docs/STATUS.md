# Статус движка

Последнее обновление: 2026-09-07.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B07-03 published; B07-04 functional accepted; canonical B07 BLOCKER=0** | B07-03 merge `467dc6af40ac6e943e7bd4d7b1af9940e9d46841`, main CI `34096118130`; B07-04 hardening head `3be87890…`, CI `34099609631` success → docs/current-head gate → pinned merge/main CI |
| Контракты/Core | **B01–B03 published** | deterministic gameplay authority |
| Runtime storage/API | **B04 published** | idempotency/fencing/SQLite/guest HTTP |
| Authoring / Control | **B05 published** | draft → validation → frozen playtest → Player |
| AI foundation | **B06 published** | provider/intent/narrator/AgentBackend boundary; canonical audit BLOCKER=0 |
| Presentation contracts | **B07-01 published** | `SceneFrameV2`, bounded `PresentationPlanV2`, immutable refs/convergence |
| Asset ingestion/storage | **B07-02 published** | trusted bytes → metadata/hash → immutable object/registry → exact read |
| Player presentation executor | **B07-03 published** | merge `467dc6af40ac6e943e7bd4d7b1af9940e9d46841`, main CI `34096118130` |
| Runtime/browser presentation wiring | **B07-04 functional accepted** | persisted presentation + strict Player parser + browser executor/renderer + exact asset proxy; hardening CI `34099609631`; canonical B07 audit BLOCKER=0 |
| Plugins | не начато | B08 after verified B07 publication |
| Auth/publish | не начато | B09 |
| Author AI helper | не начато | B10 |
| Florence migration | не начато | B11 |

## Published B07 foundation

- B07-01: merge `b52b3ee8fe8d890c22b62f1b6ebd27cda7fda2c4`, main CI `34083673425`.
- B07-02: merge `b6b9c1c61580f184114e7e49b3a16b02bb0e02a8`, main CI `34092343539`.
- B07-03: merge `467dc6af40ac6e943e7bd4d7b1af9940e9d46841`, main CI `34096118130`.

The foundation provides final reload-safe SceneFrame state, bounded non-executable one-turn plans, immutable asset identity/storage, and replay-safe Player execution.

## B07-04 — Runtime / browser integration

Branch: `b07-04-runtime-player-presentation-integration`.  
PR: #27.  
Task: [B07-04](tasks/B07-04-runtime-player-presentation-integration.md).  
Decision: [ADR 0025](decisions/0025-runtime-player-presentation-integration.md).  
Worklog: [2026-09-07 B07-04](worklog/2026-09-07-b07-04.md).  
Canonical audit: [2026-09-07 B07](audits/2026-09-07-b07-canonical-audit.md).

### Functional behavior

- presentation is attached to the same persisted committed public response;
- candidate WorldState / Core result / TurnRecord are untouched by presentation;
- idempotent replay returns the same frame/plan identity;
- malformed optional presentation is discarded without invalidating structured gameplay;
- browser uses the published `PresentationExecutor`;
- skip/reduced-motion/media failure converge to trusted target frame;
- exact-hash asset reads require the session credential and same frozen quest/release;
- browser presentation text is inserted via safe DOM/text APIs;
- image decode/audio startup failure remains presentation-only.

### Evidence

- transport/backend head `7dd8b34ede8e49a704ae9f83503581658850219c` → CI `34098637108` success;
- wired browser head `4390f6346648bc71a7112ba89e328f65ef8ede89` → CI `34099233523` success;
- hardening head `3be87890c3a4c6656a1ecb3627cf4b42068be6b3` → CI `34099609631` success;
- canonical B07 unresolved BLOCKER: **0**.

## Known limitations / follow-up

- CI does not yet launch Chromium/WebKit; real-browser automation is deferred until the product surface stabilizes.
- B07-04 reference producer is intentionally minimal and is not the Florence authored scene director.
- reference browser session persistence uses `sessionStorage`; production auth/publish belongs to B09.
- authored/narrative scene projection, richer dialogue/history and real content proof belong to B11.

## Publication Gate B07-04 / canonical B07

Remaining:

1. final current-head CI after docs sync;
2. mark PR #27 ready;
3. pinned merge at exact expected head;
4. exact merge-SHA push-to-main CI;
5. only then call B07-04 and canonical B07 published;
6. create B08 exactly from the verified B07 merge SHA.

## Overall roadmap orientation

Weighted implementation estimate: roughly **77% complete** at B07-04 functional acceptance. After verified canonical B07 publication, next block is **B08 — plugin/extension boundary**.
