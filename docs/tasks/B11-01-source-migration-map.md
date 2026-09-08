# B11-01 — source audit and migration map

Status: **GREEN — B11.0 gate closed**

Depends on: B10 published, B00 confirmed in `docs/BASELINE.md`.

## Goal

Freeze the semantic contract for moving the real Florence quest into Living History Engine before writing quest content or integration code. The migration must prove that the engine remains quest-agnostic and that legacy sessions are not rewritten.

## Exact source

- repository: `conradipui-glitch/sandbox`
- Florence merge: PR #9
- source SHA: `092bcef0be5943e32bf02f08f9e9d4cde393fa95`
- current source `main` checked at `f9b0cd0d607da48d89827f0a1a882b74e9b78e50`
- post-baseline drift: README/docs only
- exact source workflow: production run #47 / `34012448412`, success

Do not migrate from an unpinned branch tip.

## Source → Engine mapping

| Legacy source | Meaning | B11 target | Rule |
|---|---|---|---|
| `scenarioId = florence-workshop` | quest identity | immutable Florence quest release under `examples/florence` | identity selects authored content, never a Core branch |
| scenario title / role / objective | player framing | quest release metadata + authored presentation/narrative material | preserve player-facing meaning |
| Florence locations | spatial/presentation context | `core.location` blocks + presentation definitions/assets | gameplay IDs stay stable and generic |
| Giuliano / Ricci / Luca | social actors | `core.character` blocks + social authored context | no actor-specific Core code |
| five legacy metrics | bounded world pressures | explicit `core.resource` blocks where a numeric resource is genuinely needed | keep semantic role, not legacy generic metric names |
| `FlorenceMemory.facts` | durable causal facts | generic world/session state addressed by authored IDs | do not create `FlorenceMemory` in Core/runtime contracts |
| `FlorenceMemory.trace` | player decision history | runtime/playtest trace + generic state transitions | trace is evidence/history, not a quest-specific storage type |
| prepared `options` | suggested meaningful actions | authored actions/intents/conditions/effects | exactly three options is Florence presentation policy, not Core invariant |
| freeform action text | player intent | existing AI intent boundary → validated Core resolution | AI proposes/normalizes intent; Core owns state change |
| `executed` | action completed | generic successful resolution/effects | preserve semantics |
| `conditional` | request/attempt recorded but desired fact not granted | generic conditional resolution + requirement/follow-up state | never turn a request into success |
| blocked / requirement | precondition failed | generic condition failure / blocked result | atomic: no partial hidden mutation |
| metric deltas | consequence | generic effects against resource/state IDs | no client-side arithmetic |
| `turn` 1..6 | authored sequence position | **narrative beat index** | not equal to elapsed time |
| `date` + `daysPassed` | world clock | generic clock/scheduler | time advances only through explicit engine semantics |
| timeline / `lastOutcome` | consequence shown to player | runtime trace + narrative/presentation output | narrative does not become authoritative state |
| final `victory` / ending text / reflection | terminal outcome | authored terminal condition + generic runtime terminal state + narrative reflection | ending is quest data over generic mechanics |
| Florence scene cues | visual staging hints | v2 scene/presentation plan + asset refs | presentation cannot decide gameplay truth |
| three Florence backgrounds / three character portraits | source visual assets | asset ingestion/content refs used by `examples/florence` | migrate provenance/usage deliberately; do not hardcode imports in Core |
| legacy DO `StoredGame` | authoritative live session | old runtime remains owner of old session; Engine storage owns new session | no in-place save conversion |
| `processedKeys` | retry/idempotency state | existing Engine idempotency/session behavior | preserve external behavior, not storage shape |

## Florence narrative beats vs clock

The source happens to expose six successful decisions as turns. B11 must preserve **six semantic decision beats**, but must not encode `beat 4 => a fixed date increment` as a generic engine rule.

Required separation:

1. `beat` answers: where in this authored causal arc is the player?
2. `clock` answers: what in-world time has actually elapsed?
3. an action may advance both, only the beat, or neither when blocked;
4. retries never advance either;
5. a conditional result may record a fact/commitment without granting the requested world result;
6. the terminal condition is authored from state, not `if turn === 7` in Core.

The old six-turn route is therefore semantic comparison evidence, not an implementation template.

## Design changes intentionally separated from migration

These are **allowed B11 design changes** and must not be disguised as one-to-one copying:

1. Replace legacy generic metric IDs (`legitimacy`, `economy`, `army`, `stability`, `diplomacy`) with quest-named resources/state where that improves meaning.
2. Split narrative beat progression from elapsed world time.
3. Replace `FlorenceMemory` with generic authored state/facts.
4. Replace source-level `if (florence)` provider/prompt/validator branches with quest data + generic AI/runtime boundaries.
5. Move scene aliases and asset imports out of gameplay truth into presentation/assets.
6. Preserve the source causal outcomes while allowing new-engine wording/presentation to differ.

Any additional gameplay redesign found during implementation requires an explicit note in this task/PR instead of silently changing the comparison target.

## What must not enter Core

B11 fails if any of the following is required to make Florence work:

- `scenarioId === "florence-workshop"` in `packages/core`;
- a `Florence*` state/interface in generic runtime/core contracts;
- hard-coded knowledge of Giuliano, Ricci, Luca, fresco, pigment or cardinal in Core;
- a Core rule that every quest has six turns or three options;
- a Core rule that turn count determines date;
- Florence-specific arithmetic in Player/client;
- a hidden migration that converts existing legacy DO saves.

A grep/search for Florence-specific identifiers in `packages/core` is part of B11 acceptance.

## Second quest: `examples/transfer-desk`

There is already a B01 contract fixture under `packages/contracts/fixtures/transfer-desk` with:

- location `desk`;
- character `clerk`;
- resource `claim-tickets`;
- quest release `transfer-desk-r1`.

That fixture proves basic contracts only. B11 must create a **real example quest** under `examples/transfer-desk` whose causal shape differs from Florence:

- different player goal;
- item possession/transfer matters;
- at least one social interaction whose result depends on state/context;
- blocked/conditional/executed behavior is exercised;
- different resource pressure from Florence;
- its success proves the Engine is not a Florence-shaped abstraction.

Do not simply copy Florence beats and rename actors.

## Persistence / rollout contract

### Legacy sessions

- remain in `sandbox` Durable Objects;
- continue on legacy handler/runtime;
- are never silently converted to Engine state;
- remain playable under rollback while the legacy runtime is retained.

### New Florence sessions

- BFF/adapter chooses runtime at **session creation**;
- rollout flag affects only newly created Florence sessions;
- selected runtime/release is pinned for that session;
- subsequent turns do not re-evaluate a global flag and jump runtimes;
- rollback disables Engine selection for future sessions, without rewriting existing bindings.

This uses the already existing immutable release + published session binding boundary in `sandboxengine` rather than inventing B11 persistence rules.

## Semantic comparison matrix

For at least the canonical route and representative counter-routes, compare **meaning**, not exact prose:

| Check | Old source | New Engine must preserve |
|---|---|---|
| start | same player problem and known facts | equivalent initial agency/conflict |
| successful action | fact/resource consequence committed once | same causal fact, generic effects |
| conditional action | request recorded, desired outcome not invented | same distinction |
| blocked action | no partial mutation | same atomicity |
| retry | no double charge / beat advance | same idempotency |
| six-beat route | six distinct meaningful decisions | six semantic beats, clock independent |
| ending | terminal result follows accumulated facts | equivalent causal ending/reflection |
| legacy save | incompatible missing Florence memory is not fabricated | old save stays old runtime |

Required source reference route:

`draft -> ledger -> counter -> pigment -> public -> deliver`

Also include at least one paid-compromise route and one refusal/preserve-authorship route from the legacy test suite so comparison is not tuned to a single happy path.

## B11 implementation slices after this gate

### B11.1 — real quest packages

Create:

- `examples/florence`
- `examples/transfer-desk`

Add contract/schema validation and deterministic scenario tests. Florence must express its state through generic contracts and existing extension points.

### B11.2 — sandbox adapter / new-session routing

Add the smallest BFF/adapter surface required for test integration. Do not replace legacy runtime and do not alter existing saves.

### B11.3 — semantic old/new acceptance

Run canonical + counter-route comparison, rollback/session-pinning tests, and the relevant root verification suite.

## B11.0 acceptance

- [x] exact source SHA recorded
- [x] source PR/main drift checked
- [x] exact-head test/build/deploy evidence recorded
- [x] source runtime/API mapped
- [x] save format and idempotency mapped
- [x] six-decision source semantics proved by existing test suite
- [x] assets/presentation boundary identified
- [x] migration vs design change separated
- [x] new-session-only rollout contract fixed
- [x] old-session rollback contract fixed
- [x] second quest requirement distinguished from its old contract fixture

**Result: B11.0 is GREEN. Next slice: B11.1 real quest packages.**
