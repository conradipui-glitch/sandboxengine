# B07-03 — Player presentation executor: frame restore, bounded playback, skip/reload/replay safety

## Цель

Поверх published B07-01 presentation contracts и published B07-02 immutable asset boundary реализовать Player-side presentation executor, который может:

- принять подтверждённый `SceneFrameV2` как конечное визуальное состояние;
- проиграть валидированный `PresentationPlanV2` только как presentation transition;
- пропустить/ускорить эффекты и всё равно прийти к тому же target frame;
- не повторять plan после reload/retry/duplicate turn;
- не откатываться на stale revision и не угадывать пропущенные transitions;
- пережить media load/decode failure через presentation fallback без gameplay callbacks.

База: published B07-02 merge `b6b9c1c61580f184114e7e49b3a16b02bb0e02a8`, main CI `34092343539` — success.

Канонический источник: `docs/SPECIFICATION.md` §10.1–10.5, ADR 0022 и ADR 0023.

## Главный invariant

**`SceneFrameV2` — authoritative final presentation state. `PresentationPlanV2` — disposable visual transition. Player никогда не использует animation/audio/typewriter completion как gameplay commit, не вызывает Core/Runtime action из plan playback и не меняет game clock.**

## Сделать

### 1. Pure presentation executor в Player package

Добавить bounded state machine/driver в `@living-history/player`, не в Core/Runtime.

Input:

- current confirmed `SceneFrameV2 | null`;
- incoming target `SceneFrameV2`;
- optional validated `PresentationPlanV2`;
- presentation preferences (`reducedMotion`, `skipAnimations`, optional text reveal preference);
- injected renderer/adapter callbacks только presentation-типа.

Output/state минимум:

- confirmed current frame;
- playback status `idle | playing | skipped | recovered | failed` или эквивалент;
- last played/consumed turn ID;
- deterministic command delivery order;
- explicit recovery decision for stale/duplicate/gap/conflict.

### 2. Validate before playback

Executor не должен сам изобретать permissive contract.

Перед playback:

- use B07-01 frame/plan reference + convergence validation where catalog is available upstream;
- use `classifySceneFrameUpdate` / `classifyPresentationDelivery` semantics;
- ensure plan target frame/turn/revisions match incoming frame;
- unknown command cannot reach renderer;
- invalid/conflicting plan → do not partially play it; recover by applying confirmed target frame only when target frame itself is accepted by trusted upstream boundary.

Player package does not receive WorldState or private release secrets.

### 3. Sequence / parallel semantics

Implement first command set from B07-01:

- `background.set`;
- `actor.show`;
- `actor.hide`;
- `actor.move`;
- `actor.expression`;
- `item.show`;
- `dialogue.show`;
- `overlay.open`;
- `overlay.close`;
- `audio.play`;
- `audio.stop`;
- `wait`.

Semantics:

- `sequence` awaits each child in order;
- `parallel` starts children from one logical step and resolves after all complete;
- `audio.play` starts audio but does not wait for track completion;
- loop music never blocks sequence;
- `dialogue.show` resolves after reveal command; reading/“Далее” is UI-only and does not advance game clock;
- `wait` is presentation delay only.

Do not create arbitrary script/callback nodes.

### 4. Renderer adapter boundary

Create a narrow interface such as `PresentationRenderer` with presentation-only commands.

It may:

- set background visual;
- show/hide/move/change expression of actor layers;
- show item visual;
- set dialogue visible state;
- open/close overlay;
- start/stop audio;
- wait/delay.

It may **not** expose:

- sendAction;
- commitTurn;
- mutate WorldState;
- resource arithmetic;
- Runtime/Core access;
- arbitrary DOM selectors/HTML/CSS/script execution.

DOM implementation may be a later adapter; B07-03 acceptance starts with deterministic fake renderer + pure executor and then minimal existing Player integration if safe.

### 5. Skip / reduced motion

If `skipAnimations` or reduced-motion policy says no transition animation:

- do not individually replay visual command effects;
- stop/cancel in-flight presentation waits where applicable;
- apply the target `SceneFrameV2` as final presentation state;
- mark turn consumed exactly once;
- no gameplay callback.

Text can be revealed instantly.

### 6. Reload / duplicate / stale / gap

Required behavior:

- reload with latest frame: render frame directly, no historical plan replay;
- duplicate response same turn/frame: no second playback/audio;
- incoming lower revision: ignore as stale;
- same revision + different frame identity: conflict, do not overwrite confirmed frame blindly;
- plan already consumed: duplicate/no playback;
- revision gap: do not synthesize missing animations; recover from latest target frame if trusted;
- old plan arriving after newer frame: stale/no playback.

No local arithmetic may infer a missing gameplay revision/result.

### 7. Cancellation and superseding presentation

Player may need to stop presentation waits/effects when:

- user presses skip;
- a newer confirmed frame supersedes current presentation;
- view unmounts/reloads.

Cancellation is presentation-only. It must never cancel/rollback an already committed gameplay turn.

Use injected `AbortSignal`/equivalent if helpful; no background timers hidden from tests.

### 8. Media failure

B07-02 does not promise full browser codec decode.

Renderer media command failure must:

- be caught/normalized by presentation executor;
- preserve target frame identity;
- invoke neutral visual/audio fallback path or direct frame restore;
- not substitute another asset version;
- not retry gameplay;
- not replay the same turn endlessly after reload.

Background/image fallback should keep readable text/dialogue available.

### 9. Dialogue history

The confirmed `SceneFrameV2.dialogue` is the durable player-visible history.

A temporary bubble/reveal may disappear, but confirmed dialogue history must remain queryable/renderable after actor hide/reload/skip.

Executor must not discard older confirmed lines merely because one `dialogue.show` command completed.

### 10. Deterministic tests

Minimum regressions:

- sequence delivers commands in exact order;
- parallel starts siblings before waiting for all completion and does not serialize accidentally;
- audio.play does not await audio lifetime;
- valid plan ends at exact target frame identity;
- skip before playback executes no command effects and restores target frame;
- skip mid-sequence cancels remaining waits/effects and restores target frame;
- reduced motion uses instant/direct target semantics;
- duplicate turn/response does not replay plan/audio;
- reload latest frame does not replay historical plan;
- stale frame ignored;
- same revision/different frame conflict explicit;
- revision gap recovers via target frame, never guessed transitions;
- invalid/non-convergent plan not partially executed;
- renderer media failure gives fallback/direct target frame, no gameplay callback;
- dialogue history survives hide/skip/reload;
- Player package still has no Core/Control/storage authority;
- root `npm run verify` green.

## Functional acceptance

B07-03 functional gate is closed when:

1. latest SceneFrame can restore presentation without historical playback;
2. valid PresentationPlan sequence/parallel playback obeys bounded semantics;
3. skip/reduced-motion/media failure all converge to the same target frame;
4. duplicate/stale/gap behavior cannot replay or roll back committed presentation;
5. no gameplay action/clock/state mutation can be triggered by presentation completion;
6. deterministic Player tests + root verify green;
7. no Studio scene editor/B08 plugin scope entered.

## Не делать

- final visual redesign of the whole Player;
- Studio timeline/scene composer;
- new gameplay mechanics;
- public asset upload/auth;
- arbitrary DOM/HTML/CSS scripting API;
- shader/video/3D presentation;
- B08 UI plugin registry;
- B09 auth/public publish;
- B10 author AI;
- B11 Florence migration.

## Следующий slice

После published B07-03: bounded B07-04 should connect the canonical presentation output to the existing Runtime/Player HTTP response and minimal browser surface/E2E, without changing gameplay authority; then final B07 audit/closure before B08.
