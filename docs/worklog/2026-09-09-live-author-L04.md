# 2026-09-09 — L04 assistant context and response format

Branch: `feat/live-author-studio`
Baseline for this slice: `0dd00ff` (L03 commit).

## Audit result

Card points 1–6 were already implemented by the earlier scaffolding and verified now:

- canonical block schema is injected from `packages/contracts/schemas/v1/block.schema.json` into the output contract; the four existing DraftChange kinds and `missingCapabilities` are described there; runtime validation match confirmed — schema-shaped example blocks (location/character/resource/action) pass `isBlock` from `@living-history/contracts`;
- `small_quest` sends the full snapshot (all block ids, capped at 32 blocks / 64 000 chars) and re-reads revision/hash for every correction turn (B10 cycle proves baseRevision 0→1);
- `entry`-seeded mode kept; `author-context-selection.test.mjs` unchanged and green;
- over-limit quests fail with `context_too_large` before any session/network call;
- MCP reference-tool protocol stays green (`author-backend-tool-protocol.test.mjs`, `author-mcp.test.mjs`); "Return ONLY one JSON object" is already qualified by the protocol's "instead" clause when an MCP client is attached;
- single-paint Player limit lives in the output contract text, not a global capability ban.

## Change (card point 7)

- `apps/server/src/author-assistant.ts` user message used literal `\\n` (bytes `5c 5c 6e`) inside the template literal, so the model received backslash-n text instead of line breaks; replaced with real `\n` escapes. No serialized data changed.

## New tests

`apps/server/test/author-context-l04.test.mjs` (3/3):

- L04.a correction turn receives previously created `blue-paint`/`paint-wall` blocks with fresh revision; "увеличь расход краски до двух" produces one `block.replace` of the existing action (`resourceUnitsPerUnit` 1→2), no duplicate id, applies to revision 1;
- L04.b 33-block small quest fails `context_too_large` via `job.failed` checkpoint before any backend turn (0 captured requests);
- L04.c prompt contains real newlines (`Instruction:\n…\n\nBounded quest authoring context:\n`) and no literal `\n`.

## Verification

- `npm run typecheck` — exit 0;
- `node --test apps/server/test/*.test.mjs` — exit 0, 121/121 (includes MCP regression);
- `node --test packages/ai/test/*.test.mjs packages/control/test/*.test.mjs` — exit 0, 143/143;
- `apps/studio` group unchanged: 55/59 with the 4 pre-existing B05/B10-era failures;
- no paid API call.

Node `24.18.0` vs required `>=24.19.0 <25` remains an environment limitation.

## Acceptance

L04 accepted: the model-facing context is canonical, bounded, fresh after Apply, and newline-clean; over-limit fails closed before the network.

Next card: L05 — launch the frozen Player from Studio.
