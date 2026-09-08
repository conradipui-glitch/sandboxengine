# B10.b.11 — bounded MCP reference read transport

Status: targeted gate GREEN; this human-authored checkpoint exists to run full root CI on the clean production tree.

## Proven production tree

- Production MCP read commit before this checkpoint: `0848036599842586c8847db4e7583319779b7c06`.
- One-shot apply run: `34197889068` — success.
- Targeted evidence: `npm run typecheck`, `npm run test:control`, `npm run test:server`, `npm run check:boundaries`, `npm run docs:check` passed before commit.
- Temporary patcher/workflow are absent from the production tree.

## Transport contract

- Broker catalog includes only one new MCP-facing capability in this slice: `docs.reference.read`.
- MCP client configuration is injected from verified server configuration; task/Skill text cannot supply a URL, process command, credential, or new tool binding.
- This transport accepts only a bounded documentation query plus explicit target version.
- Only `docs.reference.read` may be bound; write/apply/shell/filesystem/repository/code/deployment/secret capabilities fail client validation before transport execution.
- Transport has bounded deadline and output size, aborts on timeout, and returns typed offline/timeout/transport/invalid-response results.
- Offline does not call the MCP client. Fallback is inert metadata only and is never auto-executed.
- MCP output is untrusted task material; it does not alter draft or permissions.

## Next bounded gate

After exact-head root `npm run verify` is GREEN, finish B10.b.11 backend tool-loop integration: journal/budget a brokered reference read as a durable AgentJob operation and expose only that read capability through a compatible author backend/tool bridge. Keep draft writes on the existing typed proposal path and do not add shell/filesystem/repository/deployment/secret authority.
