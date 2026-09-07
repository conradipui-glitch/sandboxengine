# Передача работы

Обновлено: 2026-09-07

Текущий блок: **B07-04 — Runtime/Player presentation integration + canonical B07 closure**  
База: published B07-03 merge `467dc6af40ac6e943e7bd4d7b1af9940e9d46841`  
B07-03 main CI: `34096118130` — success  
Ветка: `b07-04-runtime-player-presentation-integration`  
PR: #27  
Статус: **functional accepted; hardening CI `34099609631` success на `3be87890c3a4c6656a1ecb3627cf4b42068be6b3`; canonical B07 audit BLOCKER=0; docs/current-head Publication Gate pending**

## Published foundation

B01–B06 published.  
B07-01 published: presentation schema v2, final SceneFrame, bounded PresentationPlan.  
B07-02 published: immutable asset ingestion/storage/read boundary.  
B07-03 published: Player PresentationExecutor, replay/skip/recovery semantics.

Published B07 evidence:

- B07-01 merge `b52b3ee8fe8d890c22b62f1b6ebd27cda7fda2c4`, main CI `34083673425`;
- B07-02 merge `b6b9c1c61580f184114e7e49b3a16b02bb0e02a8`, main CI `34092343539`;
- B07-03 merge `467dc6af40ac6e943e7bd4d7b1af9940e9d46841`, main CI `34096118130`.

## B07-04 implementation

### Runtime / persisted response

`PresentationRuntimeStorage` wraps the existing RuntimeStorage commit boundary. It may decorate the already-calculated public action response with validated presentation, but candidate WorldState and TurnRecord are passed through unchanged.

Authority rule:

`Core/Runtime committed result -> persisted public presentation identity -> Player-only effects -> trusted target SceneFrame`

Idempotent retry returns the same persisted frame/plan identity and does not regenerate gameplay or presentation authority.

### Player transport / reload

- `RuntimePlayerClient` validates optional presentation independently;
- malformed or authority-widened presentation is discarded while valid structured gameplay remains accepted;
- session handle keeps confirmed frame + last committed operation id;
- resume loads current playerView and persisted operation frame but does not replay the historical plan;
- stale persisted frame cannot overwrite a newer Runtime revision.

### Browser

- browser imports and uses the published `PresentationExecutor`;
- minimal DOM adapter supports frame/background/actor/item/dialogue/overlay/audio/wait primitives;
- presentation strings use DOM/text APIs, not presentation-controlled `innerHTML`;
- Skip and `prefers-reduced-motion` affect only presentation;
- image decode and audio-start failure surface to executor fallback;
- presentation cancellation on reset/pagehide cannot rollback committed gameplay.

### Assets

- exact `assetId + hash` only;
- no mutable alias or client filesystem path/URL;
- guest credential required;
- asset catalog is scoped to the same frozen quest/release;
- trusted MIME from registry/store;
- corruption/missing/wrong hash fail explicitly.

## Evidence

- `7dd8b34ede8e49a704ae9f83503581658850219c` → CI `34098637108` success;
- `4390f6346648bc71a7112ba89e328f65ef8ede89` → CI `34099233523` success;
- `3be87890c3a4c6656a1ecb3627cf4b42068be6b3` → CI `34099609631` success;
- canonical audit `docs/audits/2026-09-07-b07-canonical-audit.md` → unresolved BLOCKER **0**.

ADR: `docs/decisions/0025-runtime-player-presentation-integration.md`.  
Worklog: `docs/worklog/2026-09-07-b07-04.md`.

## Honest limitations

- no real Chromium/WebKit run in CI yet;
- B07-04 reference producer is minimal/revision-based, not Florence authored scene direction;
- reference browser persistence uses sessionStorage, not production B09 auth;
- richer authored/narrative dialogue/history projection is deferred to B11.

These are FOLLOW_UP/LIMITATION, not gameplay-authority blockers.

## Publication Gate

1. final full CI on exact docs/current head;
2. update PR #27 body with final evidence and audit;
3. mark PR #27 ready;
4. merge pinned to exact expected head;
5. verify exact merge-SHA push-to-main CI;
6. only then call B07-04 and canonical B07 published.

## Next

After verified canonical B07 publication: create **B08 — plugin/extension boundary** exactly from the verified B07 merge SHA.

Do not start B08, B09 auth, final visual redesign, or Florence migration before that publication check.
