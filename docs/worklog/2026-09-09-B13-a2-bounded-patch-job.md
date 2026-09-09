# 2026-09-09 — B13.a2 bounded patch job

Branch: `feat/live-author-studio`

## Implemented

- added `apps/builder-runner/src/bounded-patch-job.ts`;
- patch operations are restricted through existing `workspace-policy` write authorization;
- evidence contains base SHA, changed paths, diff hash and resulting tree identity;
- executor contract does not include push, PR, workflow or deployment operations.

## Verification status

Not yet executed in this environment:

- `npm run test:builder` — not run;
- `npm run verify` — not run;
- CI result — not available from this change yet.

## Limitations

The current implementation is the bounded patch contract layer. A concrete filesystem sandbox writer and allowed verification command runner remain separate follow-up work before claiming full B13.a2 acceptance.
