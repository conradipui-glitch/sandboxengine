# Передача работы

Обновлено: 2026-09-07

Текущий блок: **B07-03 — Player presentation executor**  
База: published B07-02 merge `b6b9c1c61580f184114e7e49b3a16b02bb0e02a8`  
B07-02 main CI: `34092343539` — success  
Ветка: `b07-03-player-presentation-executor`  
PR: #26  
Статус: **functional gate `34095824094` success на `6ee2820bf7abcecd7a7c7108e60d4fd07a346dfb`; docs/current-head publication gate pending**

## Published foundation

B01–B06 published.  
B07-01 published: presentation schema v2, final SceneFrame, bounded PresentationPlan.  
B07-02 published: immutable asset ingestion/storage/read boundary.

B07-02 evidence: merge `b6b9c1c61580f184114e7e49b3a16b02bb0e02a8`, main CI `34092343539`.

## B07-03 implementation

`@living-history/player` now exports `PresentationExecutor` and a narrow presentation-only `PresentationRenderer`.

Authority rule:

`trusted current SceneFrame + trusted target SceneFrame + optional prevalidated plan → presentation effects only → authoritative target SceneFrame`

No renderer method can send actions, commit turns, mutate WorldState or advance game clock.

### Playback

- preflight before first command: one-turn identity, bounded node/command shape, convergence;
- sequence awaits in order;
- parallel starts siblings together and waits for all;
- audio start does not wait for track lifetime;
- dialogue reveal is presentation only;
- successful playback still finishes by applying the authoritative target frame.

### Recovery / replay safety

- skip/reduced-motion: no individual plan effects, direct target frame;
- mid-play skip aborts presentation work, then restores target frame;
- duplicate/reload: no second plan/audio playback;
- stale: ignored;
- same revision/different frame: explicit conflict;
- gap: no guessed animations, direct trusted target frame;
- invalid/non-convergent plan: zero partial command delivery, direct target frame;
- renderer/media failure: direct target frame, turn consumed once, retry becomes duplicate.

### Async hardening

Post-green audit found a real restore race. Generation guards now ensure a slow superseded restore cannot overwrite a newer frame. `cancelActive()` preserves the last confirmed frame and returns status to idle.

Canonical command duration max is rechecked at Player runtime boundary.

## Tests / CI

- `e2cfaf94d546e1436c396b664d2480360d52cae8` → CI `34095614169` success;
- `6ee2820bf7abcecd7a7c7108e60d4fd07a346dfb` → CI `34095824094` success;
- unresolved functional BLOCKER = **0**.

ADR: `docs/decisions/0024-player-presentation-executor-authority.md`.  
Worklog: `docs/worklog/2026-09-07-b07-03.md`.

## Publication Gate

1. final current-head CI after docs sync;
2. mark PR #26 ready;
3. merge pinned to exact head;
4. verify exact merge-SHA push-to-main CI;
5. only then B07-03 published.

## Next

After published B07-03: **B07-04 — wire canonical presentation output into Runtime/Player HTTP response and minimal browser surface/E2E**, then final B07 audit/closure before B08.

Do not start B08 or final visual redesign inside B07-03.
