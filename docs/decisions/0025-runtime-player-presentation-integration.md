# ADR 0025 — Runtime/Player presentation integration remains presentation-only

Date: 2026-09-07
Status: Accepted

## Context

B07-01 defined portable final `SceneFrameV2` and bounded `PresentationPlanV2`; B07-02 established immutable verified assets; B07-03 established a replay-safe Player executor. B07-04 had to connect these pieces to the real Runtime HTTP and browser Player path without creating a second gameplay authority.

## Decision

### 1. Persist presentation with the committed public response

A `PresentationRuntimeStorage` decorator may attach validated presentation to the already-authoritative action result immediately before the existing atomic `commitTurn` call.

It may not change:

- `candidateState`;
- Core action result;
- `TurnRecord` identity/revisions/state hash;
- resource/time/effect calculation;
- fencing/idempotency semantics.

Because presentation is stored in the same public response as the committed turn, idempotent replay returns the same frame/plan identity instead of regenerating presentation.

### 2. SceneFrame remains final presentation authority

`PresentationPlanV2` is disposable transition data. Player preflights it and may skip it, reject it, or abandon it after media failure. Every accepted path finishes at the trusted target `SceneFrameV2`.

Browser DOM state, animation completion, image decode and audio playback never become gameplay state.

### 3. Optional presentation fails independently

The Player transport parser validates optional presentation separately from structured gameplay response. Malformed or authority-widened presentation is discarded; an otherwise valid committed gameplay result remains valid.

### 4. Browser assets use exact immutable identity

The reference Player asset route accepts only exact `assetId + hash`, verifies an existing guest session, scopes the request to the same frozen quest/release, and reads bytes through the trusted asset store. It accepts no filesystem path, arbitrary URL, mutable alias, HTML, SVG or executable payload.

### 5. Browser rendering is a bounded adapter

The browser uses the published `PresentationExecutor`; it does not implement a second presentation state machine. Presentation-provided text is inserted through safe DOM/text APIs, not interpreted as HTML/script/CSS.

Skip and reduced-motion are presentation preferences only. Media read/decode/audio-start failure falls back to the target frame and never retries gameplay.

### 6. Reference persistence is not B09 auth

The current browser reference keeps guest session identity in `sessionStorage` to prove reload semantics. This is intentionally temporary and must not be treated as the production authentication/publication model.

## Consequences

Positive:

- one atomic gameplay commit remains authoritative;
- replay returns stable presentation identity;
- browser failure cannot rollback or duplicate a turn;
- future renderers can replace the current minimal DOM adapter without changing Core/Runtime rules;
- immutable asset identity survives browser delivery.

Trade-offs / limitations:

- the B07-04 reference producer is intentionally minimal rather than a full scene director;
- CI does not yet run a real headless browser;
- real authored/narrative scene projection belongs to Florence migration rather than this infrastructure slice.

## Rejected alternatives

- letting browser animation completion commit or acknowledge gameplay;
- regenerating a plan on idempotent retry;
- storing presentation DOM state inside `WorldState`;
- accepting mutable asset URLs or client-selected filesystem paths;
- duplicating PresentationExecutor logic in `app.js`;
- widening B07 into B09 auth or B11 content migration.
