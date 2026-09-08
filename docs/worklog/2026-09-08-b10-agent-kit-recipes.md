# B10.b.10 — checked agent-kit recipes

Status: targeted gate GREEN; this human-authored checkpoint exists to run full root CI on the clean production tree.

## Proven production tree

- Production recipe commit before this checkpoint: `283e2e63a73b32280d1da1b0c40e73601c247e0c`.
- One-shot apply run: `34196435106` — success.
- Targeted evidence in that run: patch apply, `npm run typecheck`, `npm run test:contracts`, `npm run test:server`, `npm run docs:check`, clean production commit.
- Temporary patchers and the one-shot workflow are absent from the production tree.

## B10.b.10 recipe contract

The generated installed agent kit now includes five checked recipes:

1. `quest-authoring`;
2. `scene-presentation`;
3. `plugin-extension`;
4. `ui-provider-extension`;
5. `migration-validation`.

Each recipe is generated documentation/task material, participates in `docsHash`, points only at existing repository paths, and lists only explicitly allowlisted npm scripts that also exist in root `package.json`. Recipe text grants no shell, filesystem, repository mutation, deployment, secret-read, publish, or gameplay authority.

The authenticated installed agent-kit read serves the same recipe files that are included in `docsHash`, so a recipe change invalidates the write handshake until the caller refreshes the installed kit.

## Next bounded gate

After exact-head root `npm run verify` is GREEN, continue with **B10.b.11 Skills/MCP broker foundation** only.

Required invariants for that slice:

- Skill/MCP text never grants authority;
- broker policy is server-owned and allowlist-based;
- no shell/filesystem/repository/deployment/secret capabilities;
- MCP offline/timeout returns typed failure without widening permissions;
- active job pins the selected skill/tool contract so a mid-job update cannot silently change permissions/context;
- draft mutation still goes only through existing typed proposal Apply + exact agent-kit handshake;
- do not mark broad `control.capabilities` available merely because broker internals exist.
