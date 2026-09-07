# ADR 0024 — SceneFrame authority and disposable Player presentation playback

Date: 2026-09-07
Status: accepted for B07-03 functional gate

## Context

B07-01 published reload-safe `SceneFrameV2` and bounded `PresentationPlanV2`. B07-02 published immutable verified assets. B07-03 must execute presentation without turning animation/audio completion into gameplay authority or replaying committed turns after reload/retry.

## Decision

1. `SceneFrameV2` is the authoritative final Player presentation state. A `PresentationPlanV2` is a disposable one-turn transition only.
2. Player owns a pure `PresentationExecutor`; Core/Control/storage are not reachable from its renderer adapter.
3. A plan is preflight checked for one-turn identity, bounded command/tree shape and target-frame convergence before the first renderer command. Invalid/non-convergent plans are never partially played; the trusted target frame is restored directly.
4. `sequence` awaits children in order; `parallel` starts siblings together and awaits the group. Audio start is a presentation command, not a wait for track lifetime.
5. Skip and reduced-motion bypass individual effects and apply the target frame directly. Mid-play skip aborts presentation work only.
6. Duplicate/reload/stale/conflict/gap decisions never infer missing gameplay state. Reload restores the latest frame and historical plans are not replayed.
7. Renderer/media failure degrades to direct target-frame restoration and consumes the presentation turn once; it cannot retry Core or substitute another asset identity.
8. Async restore/playback uses generation guards. A slow superseded operation cannot overwrite a newer confirmed frame. `cancelActive()` leaves the last confirmed frame intact and executor idle.
9. Runtime objects cannot widen the canonical per-command duration bound (`PRESENTATION_MAX_DURATION_MS`).
10. Confirmed `SceneFrameV2.dialogue` remains the durable dialogue history regardless of transient bubble/actor effects.

## Consequences

- Browser/DOM code can be added later as an adapter without changing the authority model.
- Presentation cancellation is safe after gameplay commit because it never rolls gameplay back.
- B07-04 may wire Runtime/HTTP presentation payloads to this executor, but must not add gameplay callbacks to renderer methods.

## Evidence

- first implementation head `e2cfaf94d546e1436c396b664d2480360d52cae8` → CI `34095614169` success;
- race/bounds hardening head `6ee2820bf7abcecd7a7c7108e60d4fd07a346dfb` → CI `34095824094` success;
- hardening audit unresolved functional `BLOCKER = 0`.
