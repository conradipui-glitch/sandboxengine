# B10.b.11 — durable author reference tool loop

Bounded slice: make `docs.reference.read` explicit job authority instead of ambient broker authority, journal/budget it before MCP transport, and expose one read-only safe bridge without widening the existing `AgentBackend` contract.

Evidence required before GREEN:

- reduced grants cannot call `docs.reference.read`;
- configured author jobs gain exactly that operation and no shell/fs/repo/code/deploy/secret authority;
- exact retry replays the durable result without a second MCP call;
- changed request under the same operation ID is denied;
- offline is journaled/budgeted and never auto-falls back;
- completed reference output replays after SQLite reopen;
- targeted Control/Server/boundary/docs checks and then exact-head root `npm run verify` are green.
