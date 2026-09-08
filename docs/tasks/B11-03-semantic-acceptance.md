# B11-03 — semantic old/new acceptance

Status: **GREEN for semantic/runtime routing; asset + client rollout gates remain open**

## Exact evidence

### Legacy source

- repository: `conradipui-glitch/sandbox`
- pinned source SHA: `092bcef0be5943e32bf02f08f9e9d4cde393fa95`
- source test: `src/worker/florence-engine.test.ts`

The source proves these distinct meanings:

1. `draft -> ledger -> counter -> pigment -> public -> deliver`
   - `draft` is conditional: the request exists but agreement is not invented;
   - with draft + ledger support, `counter` becomes executed;
   - final meaning: `Незавершённое принято`.
2. `healer -> team -> advance -> testimony -> share-ledger -> deliver`
   - the advance is actually received;
   - authorship is not secured by that payment;
   - final meaning: `Чужое имя над вашей работой`.
3. `close -> refuse -> protect -> testimony -> rest -> sign`
   - no agreement is fabricated;
   - final meaning: `Имя без заказчика`.
4. `withdraw`
   - returns money only if an advance was actually received;
   - otherwise it only withdraws the proposal/deal;
   - a withdrawn deal cannot silently become accepted later.
5. Retry/save semantics
   - one successful action is charged/advanced once;
   - retry does not double-charge;
   - missing legacy Florence memory is not invented during restore.

## Engine semantic representation

Florence is expressed as authored data over generic Engine primitives:

- `WorldState` resources represent explicit durable state, including `contract-rights` and `deal-open`;
- authored option `cases` use the existing generic Core `Condition` language;
- case effects still pass through `tryApplyEffectBatch`;
- default `conditional` remains conditional unless an authored generic condition is satisfied;
- final terminals are selected from accumulated authoritative state;
- no Florence identity or actor-specific rule is added to `packages/core`.

The semantic adapter therefore preserves source causality without reintroducing `if (scenarioId === "florence-workshop")` into Core.

## Acceptance matrix

| Meaning | Legacy source | Engine proof |
|---|---|---|
| Draft/request is not agreement | `draft` is conditional | authored `draft` remains conditional and does not grant `contract-rights` |
| Evidence can turn a counter-offer into agreement | `draft && ledger` makes `counter` executed | generic condition over accumulated state makes `counter` executed |
| Weak counter-offer remains pending | insufficient source facts => conditional | no matching authored case => default conditional |
| Canonical ending | `Незавершённое принято` | rights-backed `deliver` => `Незавершённое принято` |
| Paid compromise | `Чужое имя над вашей работой` | paid/open deal without rights => same terminal meaning |
| Preserve authorship | `Имя без заказчика` | unsigned-rights `sign` => same terminal meaning |
| Recognized signature | agreed + sign => `Имя, прочитанное вслух` | rights-backed `sign` => same terminal meaning |
| Withdrawal | only real advance is returned | generic cases return only recorded cash and set `deal-open = 0` |
| Withdrawal blocks silent acceptance | withdrawn source deal stays withdrawn | `deal-open = 0` prevents agreement cases; delivery is `Фрагмент без печати` |
| Blocked action | no partial mutation | authored/Transfer Desk blocked path finishes without turn |
| Conditional action | records attempt without desired result | authored conditional commits one beat without inventing rights/items |
| Atomic effects | failed batch does not partly mutate | existing Core `tryApplyEffectBatch` gate |
| Retry | no double commit/charge | RuntimeStorage claim/replay persists exact response |
| Beat vs clock | semantic turns are not time | each authored option has explicit independent clock seconds |

## Runtime / BFF evidence

### Engine

- PR: `conradipui-glitch/sandboxengine#35`
- semantic exact head: `4c3453bd7c4106860185219aaae52503588d1289`
- CI: run `34234424254` / #669 — **success**
- full root `npm run verify` passed.

### Sandbox BFF

- PR: `conradipui-glitch/sandbox#10`
- exact head: `f070258112528902121c7c3de1ff399a1e182035`
- Verify: run `34232951480` / #3 — **success**
- proves:
  - Engine selection only at new-session creation;
  - durable route pinning survives rollout flag changes;
  - no binding means legacy fallback;
  - prepared options route as `authored.option`;
  - free text stays behind the intent boundary;
  - malformed prepared input fails before upstream action execution.

## Still open before B11 publication

1. **Client-compatible Engine presentation/response path** — current BFF test envelope is intentionally not legacy `GameState`; rollout `on` must not be enabled until the player can render the Engine response safely.
2. **Florence binary asset gate** — source visual/audio identities are pinned, but byte-safe copy/ingestion is not yet complete.
3. Final exact-head verification after those two gates, then update status/handoff and publish/merge B11.

Until those are closed, PR #35 and sandbox PR #10 remain draft and `ENGINE_FLORENCE_ROLLOUT=on` is not an accepted production state.
