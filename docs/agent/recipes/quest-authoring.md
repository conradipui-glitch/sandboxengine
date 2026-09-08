# Quest authoring

Prepare bounded typed quest draft changes through canonical AuthoringProposal preview/apply semantics.

> This recipe is generated documentation/task material only. It does not grant tools, permissions, shell access, repository mutation, deployment authority, secret access, or gameplay authority.

## Required repository paths

- `packages/contracts/schemas/v1/block.schema.json`
- `packages/control/src/authoring-proposal.ts`

## Verification commands

These commands are evidence instructions for an authorized external workflow; this agent kit does not itself grant command execution.

- `npm run test:contracts`
- `npm run test:control`
- `npm run test:server`

## Invariants

- Use typed Control draft changes only and bind them to the exact base revision/content hash.
- Preview and validate on a copy before Apply; stale bases never authorize overwrite.
- Quest authoring does not publish releases, change access roles, or mutate Runtime/player state.
