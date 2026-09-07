# B07-04 — Runtime/Player presentation integration + minimal browser E2E + final B07 closure

## Goal

Wire the published B07 presentation foundation into the real Runtime/HTTP/Player path without changing gameplay authority.

Base: published B07-03 merge `467dc6af40ac6e943e7bd4d7b1af9940e9d46841`, main CI `34096118130` — success.

Published inputs:

- B07-01 `SceneFrameV2` + bounded `PresentationPlanV2`;
- B07-02 verified immutable asset identity/storage;
- B07-03 `PresentationExecutor` + replay/skip/recovery semantics.

## Main invariant

**Runtime may deliver trusted presentation data, and Player may render it, but presentation never becomes gameplay authority. Core result / persisted turn remain canonical; animation completion, media decode and DOM state can never commit, retry or mutate gameplay.**

## Do

### 1. Runtime public response

Extend the existing successful committed-turn response with an optional bounded presentation payload containing only:

- trusted target `SceneFrameV2`;
- optional validated `PresentationPlanV2` for that exact committed turn;
- exact immutable asset references already present in the frame/plan.

Requirements:

- backward compatible: old clients can ignore the field;
- persisted public response includes the presentation payload so idempotent retry returns byte-equivalent presentation identity;
- replay/retry must not regenerate a new plan or asset version;
- processing/no-turn outcomes do not fabricate a committed presentation turn;
- no WorldState/private release/provider/storage path leakage.

### 2. Presentation producer boundary

Use a deterministic/trusted presentation builder for the frozen reference path in this slice. It may derive frame/plan from already-authoritative committed public facts and frozen release presentation data.

It must not:

- calculate gameplay outcome;
- change resources/time/effects;
- invoke AI as authority;
- use client arithmetic;
- emit arbitrary executable presentation commands.

Before attaching a plan, validate B07-01 reference/convergence rules. Invalid plan -> omit transition and send trusted target frame only.

### 3. Asset delivery boundary

Expose browser-consumable asset bytes only by exact verified `assetId + hash` identity or a bounded resolver abstraction.

For test/reference implementation:

- trusted MIME comes from registry;
- no arbitrary filesystem path/URL from client;
- wrong hash/missing/corrupt asset fails explicitly;
- no silent fallback to another version with same assetId.

Do not add general public upload/auth UI in B07-04.

### 4. Player client parsing

Extend `@living-history/player` Runtime response parser with optional presentation payload validation:

- exact expected schema/identity fields;
- reject malformed extra executable/gameplay authority fields;
- old response without presentation remains valid;
- malformed optional presentation must not corrupt structured gameplay result.

### 5. Minimal browser renderer

Add a minimal existing-Player adapter for `PresentationRenderer` sufficient to prove the full path:

- apply final frame;
- background;
- actor layer show/hide/move/expression;
- item visual;
- dialogue/history;
- overlay;
- audio start/stop;
- wait/transition timing through bounded browser primitives.

No final visual redesign. No arbitrary selectors/HTML/CSS/script API.

All text injected through safe DOM/text APIs, not `innerHTML` from presentation data.

### 6. Browser behavior

Wire user preferences:

- skip animation control;
- `prefers-reduced-motion` -> direct target semantics;
- reload latest frame -> no historical playback;
- duplicate turn -> no second audio/animation;
- media failure -> readable target frame/fallback, no gameplay retry.

### 7. E2E / integration evidence

Minimum:

- committed Runtime turn returns matching `action/playerView` plus presentation payload;
- idempotent retry returns same presentation turn/frame and does not rebuild/replay authority;
- Player client accepts response and passes frame/plan to executor;
- browser initial/reload renders latest frame directly;
- one normal next turn plays plan then ends at exact target frame;
- skip before/mid playback ends at same target frame;
- reduced motion ends at same target frame with no transition effects;
- duplicate response does not replay audio/animation;
- malformed/non-convergent presentation plan falls back to target frame;
- missing/corrupt media does not trigger gameplay action/retry;
- presentation text is escaped/safe;
- no client-side resource/time arithmetic;
- root `npm run verify`, `test:player` and `test:e2e` green.

### 8. Final B07 audit

After functional green, audit B07 end-to-end:

- authority separation;
- immutable asset identity;
- reload/replay/idempotency;
- media failure;
- skip/reduced-motion/accessibility;
- public/private boundary;
- browser executable-content boundary;
- no B08/B09 scope leakage.

Fix unresolved `BLOCKER` before publication. Record `FOLLOW_UP`/`LIMITATION` honestly.

## Functional acceptance

B07-04 and canonical B07 are closed when:

1. real Runtime committed response carries bounded persisted presentation identity;
2. Player client/executor/browser surface consume it without gameplay authority;
3. reload/duplicate/skip/reduced-motion/media failure converge correctly;
4. asset reads are exact-hash and no executable/untrusted-path surface is introduced;
5. browser/integration/E2E and full root verify are green;
6. final B07 audit has zero unresolved BLOCKER;
7. docs/current-head gate, pinned merge and exact main push CI succeed.

## Not now

- final visual redesign / art direction polish;
- Studio timeline editor;
- public asset upload/auth management;
- B08 plugin registry;
- B09 auth/public publishing;
- B10 author AI helper;
- B11 Florence migration.

## Next after canonical B07 closure

**B08 — plugin/extension boundary**, created only from the verified final B07 merge SHA.
