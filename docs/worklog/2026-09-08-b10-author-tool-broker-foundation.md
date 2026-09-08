# B10.b.11 — author tool broker foundation

Status: targeted gate GREEN; this human-authored checkpoint exists to run full root CI on the clean production tree.

## Proven production tree

- Production broker commit before this checkpoint: `8c6467c18e3d7a55810e3fb97dc4919a192ae728`.
- One-shot apply run: `34197382700` — success.
- Targeted evidence: `npm run typecheck`, `npm run test:control`, `npm run test:server`, `npm run test:studio`, `npm run check:boundaries`, `npm run docs:check` all passed before the production commit.
- Temporary patcher/workflow are absent from the production tree.

## Broker foundation

- Server-owned default-deny policy is independent of Skill/MCP text.
- Trusted tool IDs are limited to current implemented authoring operations plus installed agent-kit read.
- Shell, filesystem, repository mutation, code execution, deployment and secret-read tool IDs are not trusted capabilities.
- Current installed docs/Skill hash, broker policy hash and exact job-granted tool set are pinned durably as `broker.pinned` in the existing job checkpoint journal.
- A docs/Skill hash change on the same active job produces a pinned mismatch rather than silently changing permissions.
- Current `draft.read`, proposal preview, auto-apply and job-scoped manual Apply pass broker authorization; manual Apply still also requires the existing exact agent-kit handshake.
- MCP-unavailable is a typed broker result. A builtin fallback, where declared, is returned as an inert suggestion and must be explicitly re-authorized; it is never executed automatically.

## Next bounded gate

After exact-head root `npm run verify` is GREEN, continue B10.b.11 with a bounded read-only MCP transport contract behind this broker. The transport may invoke only already-authorized read operations, must enforce timeout/offline/invalid-response bounds, and must not introduce shell/filesystem/repository/deployment/secret or draft-write authority.
