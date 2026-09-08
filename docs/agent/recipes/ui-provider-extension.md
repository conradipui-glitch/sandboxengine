# UI/provider extension

Extend Studio UI or AI provider composition without moving credentials or authority into the browser.

> This recipe is generated documentation/task material only. It does not grant tools, permissions, shell access, repository mutation, deployment authority, secret access, or gameplay authority.

## Required repository paths

- `apps/studio/src/api.ts`
- `packages/ai/src/provider.ts`
- `packages/ai/src/agent-backend.ts`

## Verification commands

These commands are evidence instructions for an authorized external workflow; this agent kit does not itself grant command execution.

- `npm run test:ai`
- `npm run test:studio`
- `npm run check:boundaries`

## Invariants

- Browser state is presentation/transport only and never becomes authorization or revision authority.
- Provider credentials stay server-side and provider/AgentBackend code cannot write drafts or gameplay state directly.
- This recipe grants no shell, filesystem, repository mutation, deployment, or secret-read capability.
