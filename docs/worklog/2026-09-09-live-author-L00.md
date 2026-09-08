# 2026-09-09 — L00 baseline review live authoring

Branch: `feat/live-author-studio`
Base SHA: `6f2ad73fca228c60361012250b72609447edc968`
Head SHA: `1bc76c1facbb84ea573f7e29908dfa1d7bc5cb7b`

## Result

L00 baseline review completed from repository evidence.

Confirmed:

- branch is two commits ahead of the B12 base: `e3a9173` scaffolding followed by `1bc76c1` L00 bookkeeping;
- the first commit only contains initial live-authoring scaffolding and documentation updates;
- no B12 release evidence was incorrectly transferred into the unfinished live-author path;
- existing changes are bounded to provider adapter preparation, Studio provider settings, author context contract preparation and docs.

Changed files reviewed:

- `packages/ai/src/model-agent-backend.ts`
- `packages/ai/src/index.ts`
- `apps/studio/src/local-author-provider.ts`
- `apps/studio/src/provider-settings.ts`
- `apps/studio/src/dev-server.ts`
- `apps/studio/src/main.ts`
- `apps/server/src/author-assistant.ts`
- `apps/server/src/author-output-contract.ts`
- documentation files.

## Evidence boundary

Fresh L00 evidence:

- `npm ci` exit 0; npm reported an environment-only `EBADENGINE` warning because Node is `24.18.0`, while the repository requires `>=24.19.0 <25`;
- `npm run typecheck` exit 0 (TypeScript 5.9.3);
- `node --test apps/studio/test/b10-full-author-assistant-cycle.test.mjs` exit 0, 1/1 pass;
- generated `dist/`, `tsconfig.tsbuildinfo`, and `node_modules/` are local verification artifacts and are not part of the source diff.

The Node engine mismatch is an environment limitation, not a product failure. A Node `24.19.0` rerun remains desirable before final acceptance.

Not proven yet:

- full verify on this branch;
- browser acceptance;
- HTTP adapter live path;
- real provider run;
- Player launch from Studio;
- complete author → apply → correction → frozen Player cycle.

## Acceptance

L00 accepted as repository baseline review only.

Next card: L01 — local HTTP boundaries before paid API usage.
