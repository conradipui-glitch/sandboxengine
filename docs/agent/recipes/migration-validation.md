# Migration validation

Validate compatibility-sensitive changes without claiming an automatic migration implementation.

> This recipe is generated documentation/task material only. It does not grant tools, permissions, shell access, repository mutation, deployment authority, secret access, or gameplay authority.

## Required repository paths

- `packages/contracts/schemas/v1/block.schema.json`
- `packages/contracts/schemas/v2/scene-frame.schema.json`
- `scripts/generated-docs.mjs`

## Verification commands

These commands are evidence instructions for an authorized external workflow; this agent kit does not itself grant command execution.

- `npm run typecheck`
- `npm run test:contracts`
- `npm run docs:check`
- `npm run verify`

## Invariants

- Treat compatibility/hash mismatch as explicit evidence; never silently rewrite authored history or immutable releases.
- Generated docs and schemas must remain deterministic and current before compatibility is accepted.
- This is validation guidance only; it does not claim an automatic migration, publish, rollback, or deployment tool.
