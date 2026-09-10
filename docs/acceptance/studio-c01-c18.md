# Studio V00–V02 C01–C18 evidence ledger

Дата: 2026-09-10  
Branch: `feat/b13-acceptance-closure`  
Correction baseline: `bc8313d`  
Current local candidate: see `git rev-parse HEAD`  

> This ledger uses the explicit V00–V02 acceptance requirements from the task. The
> original review files named in the task were not present in this checkout, so
> no hidden review wording is claimed. **GREEN is prohibited while any row is
> OPEN/SKIPPED.**

| ID | Observable criterion | Evidence | Scope/status |
|---|---|---|---|
| C01 | Namespaced Studio entry loads | `correction-acceptance.test.mjs` C01; `static-entry.test.mjs` | LOCAL PASS |
| C02 | Board projects canonical draft, not a game copy | acceptance C02; `board-model.test.mjs` | LOCAL PASS |
| C03 | Four supported canonical block kinds can be created | acceptance C03; `block-inspector.test.mjs`; CDP create smoke | LOCAL + BROWSER PASS |
| C04 | Inspector emits full `block.replace` and preserves untouched fields | acceptance C04; K03 inspector/conflict CDP smoke | LOCAL + BROWSER PASS |
| C05 | Allowed character→location/action→resource links persist as canonical changes | acceptance C05; K04 pointer smoke; board permission HTTP | LOCAL + BROWSER PASS |
| C06 | Unsupported links are rejected without changing edge count | acceptance C06; K04 pointer smoke | LOCAL + BROWSER PASS |
| C07 | Moving nodes updates edge geometry | acceptance C07; K04 two-drag CDP smoke | LOCAL + BROWSER PASS |
| C08 | Fallback layout has no collisions | acceptance C08; board-model regression | LOCAL PASS |
| C09 | One renderer keeps viewport/selection across updates | acceptance C09; board-lifecycle suite; K04 tab switch | LOCAL + BROWSER PASS |
| C10 | Server BoardDocument is separate from draft/contentHash | acceptance C10/C11; SQLite store suite | LOCAL PASS |
| C11 | Layout CAS/revision survives close/reopen and another browser | acceptance C11; K05 profile A→B CDP readback (`boardRevision=1`, server position, empty B localStorage) | LOCAL + BROWSER PASS |
| C12 | Idempotency replay/reuse and stale CAS are distinct | acceptance C12; board-document store/HTTP suites | LOCAL PASS |
| C13 | Viewer/tester read-only; editor write requires CSRF/role | acceptance C13; K06 board permissions HTTP | LOCAL PASS |
| C14 | Hosted identity cannot be forged and revocation takes effect | K06 `board-permissions-http.test.mjs`; `control-http.test.mjs` | LOCAL PASS |
| C15 | Pan/zoom/fit bounds and read-only behavior | acceptance C15; K04 pointer/wheel/space/fit smoke | LOCAL + BROWSER PASS |
| C16 | V00 namespaces and legacy root separation remain intact | K07 selected suite; public VPS unauth matrix | LOCAL + VPS unauth PASS |
| C17 | Independent frozen Player can launch and return server runtime result | Player UI/launch/full-cycle suites; K07 selected suite | LOCAL PASS |
| C18 | Exact candidate SHA deployed and authenticated VPS browser scenario passes | Remote read-only proof: final branch candidate and rebuilt Studio image were read back after deployment; Studio/Engine loopback 200; public unauth asset matrix and C18 boundary test pass. Authenticated Telegram browser scenario is still unavailable (no session; browser tool timeout). | **PARTIAL / AUTH OPEN** |

## Reproducible local commands

```bash
npx --yes -p node@24.19.0 -p npm@11.9.0 -c "npm run typecheck"
npx --yes node@24.19.0 --test apps/studio/test/correction-acceptance.test.mjs
npm run test:control
npm run test:server
npm run test:studio
```

The acceptance suite currently reports **18 tests: 17 passed, 1 skipped (C18)**.
C18 must be run with `CORRECTION_VPS_URL` only after the exact candidate is
actually deployed; a public HTTP 200 alone is not evidence.

## Security/scope notes

- Existing Telegram/cookie auth mechanics are unchanged.
- No credentials, cookies, tokens, or provider keys are stored in this ledger.
- Florence and «Приёмка VPS» are not used as test fixtures.
- Engine, gate, production game and other repositories are outside the Studio-only change scope.
