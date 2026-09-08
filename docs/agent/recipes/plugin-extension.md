# Plugin extension

Prepare a manifest-bound plugin extension that stays inside installed plugin contracts.

> This recipe is generated documentation/task material only. It does not grant tools, permissions, shell access, repository mutation, deployment authority, secret access, or gameplay authority.

## Required repository paths

- `packages/plugins/schemas/v1/plugin-manifest.schema.json`
- `packages/plugins/registry/installed.json`

## Verification commands

These commands are evidence instructions for an authorized external workflow; this agent kit does not itself grant command execution.

- `npm run test:plugins`
- `npm run test:core`
- `npm run test:server`
- `npm run check:boundaries`

## Invariants

- Plugin-owned IDs and capabilities must be declared by a compatible installed manifest.
- No executable URL, raw HTML, secret, or repository/deployment authority is granted by a plugin recipe.
- Core remains generic; plugin output still passes existing canonical Core validation gates.
