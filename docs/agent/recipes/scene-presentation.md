# Scene presentation

Change presentation data without widening it into gameplay authority.

> This recipe is generated documentation/task material only. It does not grant tools, permissions, shell access, repository mutation, deployment authority, secret access, or gameplay authority.

## Required repository paths

- `packages/contracts/schemas/v2/scene-frame.schema.json`
- `packages/contracts/schemas/v2/presentation-plan.schema.json`
- `apps/player/presentation-renderer.js`

## Verification commands

These commands are evidence instructions for an authorized external workflow; this agent kit does not itself grant command execution.

- `npm run test:contracts`
- `npm run test:player`
- `npm run check:boundaries`

## Invariants

- Presentation references exact allowed assets/actors and remains reload-safe.
- Presentation commands cannot mutate gameplay state or execute arbitrary code.
- Renderer changes must preserve the existing Player/Runtime/Core authority boundary.
