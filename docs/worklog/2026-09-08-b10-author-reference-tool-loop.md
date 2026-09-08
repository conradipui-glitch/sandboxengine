# B10.b.11 — durable author reference tool loop

Bounded slice: make `docs.reference.read` explicit job authority instead of ambient broker authority, journal/budget it before MCP transport, and expose one read-only safe bridge without widening the existing `AgentBackend` contract.

Evidence:

- reduced grants cannot call `docs.reference.read`;
- configured author jobs gain exactly that operation and no shell/fs/repo/code/deploy/secret authority;
- exact retry replays the durable result without a second MCP call;
- changed request under the same operation ID is denied;
- offline is journaled/budgeted and never auto-falls back;
- completed reference output replays after SQLite reopen;
- targeted Control/Server/boundary/docs gate `34200701399` completed successfully and self-cleaned all staging files;
- production implementation commit is `aa11f59b8976f26d63a2325a638f12b9e4888148`.

This human-authored checkpoint exists to trigger the exact-head root `npm run verify` after the bot-authored production commit. The slice is not called fully GREEN until that root run succeeds.

Next bounded gate after root GREEN: compatible backend tool-loop protocol — a deterministic tool-aware author backend may request only the safe `docs.reference.read` bridge, receive bounded reference material in the same segment, and remain subject to broker grant, durable replay, deadline/cancel and segment budget. The existing no-tools `AgentBackend` contract remains unchanged; external task package, Codex, shell/filesystem/repository/deployment authority remain out of scope.
