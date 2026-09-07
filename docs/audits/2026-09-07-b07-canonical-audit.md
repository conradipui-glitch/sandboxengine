# B07 canonical audit — Presentation / assets / Player integration

Date: 2026-09-07
Scope: B07-01 through B07-04
Audit head before documentation sync: `3be87890c3a4c6656a1ecb3627cf4b42068be6b3`
CI: `34099609631` — success

## Verdict

Canonical B07 has **0 unresolved BLOCKER**.

B07 now provides a bounded, non-gameplay presentation path:

`committed Core/Runtime result -> persisted SceneFrameV2 + optional PresentationPlanV2 -> Player parser -> PresentationExecutor -> browser presentation adapter -> authoritative target SceneFrameV2`

Presentation cannot commit a turn, alter WorldState, advance gameplay time, recalculate resources, or trigger gameplay retry.

## Audit matrix

| Area | Result | Evidence / note |
|---|---|---|
| Gameplay authority | NO_FINDING | Presentation storage decorator never changes candidateState or TurnRecord; Core/Runtime remain authoritative. |
| Presentation contract | NO_FINDING | SceneFrameV2 is final reload-safe state; PresentationPlanV2 is bounded, typed, non-executable and validated for identity/convergence. |
| Plan execution | NO_FINDING | Preflight happens before renderer commands; sequence/parallel/skip/reduced-motion/media failure all end at trusted target frame. |
| Idempotency / replay | NO_FINDING | Presentation is persisted inside the same committed public response; retry returns the same presentation identity. |
| Reload / stale / duplicate | NO_FINDING | Player restore uses confirmed frame; historical plan is not replayed on resume; stale/conflicting/gapped inputs fail closed. |
| Asset identity | NO_FINDING | Browser asset route is exact `assetId + hash`; no fallback to another version; MIME comes from trusted registry record. |
| Asset authorization | NO_FINDING | Asset access requires the guest credential and is scoped to the same frozen quest/release before bytes are served. |
| Media failure | NO_FINDING | HTTP/read/decode/audio-start failures remain presentation-only and converge to readable target/fallback; no gameplay retry. |
| Browser executable-content boundary | NO_FINDING | Presentation data is rendered with DOM/text APIs; no arbitrary selector/HTML/CSS/script command surface is exposed. |
| Public/private boundary | NO_FINDING | Presentation payload contains bounded public scene data and immutable refs; no WorldState, contentHash, fencing token, provider evidence or filesystem path is exposed. |
| Client arithmetic | NO_FINDING | Resource/time/action numbers continue to come from structured Runtime/Core response; presentation does not calculate gameplay values. |
| B08/B09 leakage | NO_FINDING | No plugin registry, public upload management, or production auth/publish system was added. |

## Cross-slice proof

### B07-01 — contracts

- presentation schema namespace `2.0` without breaking frozen legacy v1;
- `SceneFrameV2` final state;
- bounded `PresentationPlanV2` command tree;
- immutable asset references;
- semantic catalog/reference validation and target-frame convergence.

Published evidence: merge `b52b3ee8fe8d890c22b62f1b6ebd27cda7fda2c4`, main CI `34083673425`.

### B07-02 — assets

- byte-signature inspection;
- trusted SHA-256;
- bounded image/audio profiles;
- immutable content-addressed storage and exact reads;
- no SVG/HTML/script ingestion path;
- malformed/corrupt/path-traversal cases fail closed.

Published evidence: merge `b6b9c1c61580f184114e7e49b3a16b02bb0e02a8`, main CI `34092343539`.

### B07-03 — Player executor

- pure presentation state machine;
- sequence/parallel;
- skip/reduced-motion;
- duplicate/stale/conflict/gap handling;
- renderer/media failure fallback;
- generation guard against superseded async restore/playback.

Published evidence: merge `467dc6af40ac6e943e7bd4d7b1af9940e9d46841`, main CI `34096118130`.

### B07-04 — Runtime/browser integration

- presentation attached immediately before the existing atomic commit;
- persisted public response carries exact frame/plan identity;
- Player parser validates optional presentation independently from gameplay response;
- browser uses the published PresentationExecutor rather than a second executor implementation;
- initial frame, resume, skip and reduced-motion are wired;
- exact-hash session/release-scoped asset proxy;
- browser media decode/start failures surface to executor fallback.

Functional/hardening evidence:
- transport/backend head `7dd8b34ede8e49a704ae9f83503581658850219c` -> CI `34098637108` success;
- wired browser/integration head `4390f6346648bc71a7112ba89e328f65ef8ede89` -> CI `34099233523` success;
- final hardening head `3be87890c3a4c6656a1ecb3627cf4b42068be6b3` -> CI `34099609631` success.

## LIMITATION

1. CI does not launch a real Chromium/WebKit engine. Browser behavior is proven by module/proxy/client/executor regressions and bounded browser adapter code, not by a headless-browser automation stack.
2. The B07-04 reference presentation producer is deliberately minimal and revision-based. It proves the transport/execution boundary but is not the Florence scene director and does not yet project authored/narrator dialogue history into the reference frame.
3. Browser media validity ultimately depends on the browser decoder; B07 handles decode/start failure safely but cannot prove every supported browser codec implementation.
4. `sessionStorage` persistence is a temporary guest-session convenience for the reference Player, not the B09 production authentication/persistence design.

## FOLLOW_UP

- B08: introduce the trusted plugin/extension boundary without widening presentation command authority.
- B09: replace reference guest/browser persistence with the intended auth/publication model.
- B11: migrate Florence and provide real authored presentation/frame production, including dialogue/history and asset-rich scenes; add real-browser playtest automation when the product surface is stable enough to justify it.

## Closure

Unresolved BLOCKER: **0**.

B07 may enter Publication Gate. It is not called published until docs/current-head CI, pinned merge, and exact main push CI all succeed.
