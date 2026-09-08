# B10.b.11 — compatible backend tool-loop protocol

Bounded goal: allow a compatible author backend to ask the host for at most one `docs.reference.read` during a segment without giving the backend a tool handle or widening `AgentBackend`.

Required evidence before GREEN:

- old `AgentBackend` safe view remains `toolPolicy: none` with shell/filesystem/code/repository/external tools false;
- strict in-band request accepts only `docs.reference.read`; unknown/second requests fail closed;
- host executes the request through the durable brokered bridge and feeds bounded `tool_result` task material into the same session;
- call accounting combines both backend turns honestly;
- tool operation consumes segment budget and resume replays the MCP result without a second transport call;
- shared deadline produces typed MCP timeout rather than hidden fallback;
- parent cancellation aborts MCP and prevents the second backend turn;
- targeted AI/Control/Server/boundary/docs gates and final exact-head root `npm run verify` are GREEN.

Targeted gate evidence:

- one-shot run `34202744446` completed success;
- Typecheck, Control regressions, full Server regressions, boundary gate, docs gate and diff gate all passed;
- self-clean removed both staging patchers, the one-shot workflow and the temporary type diagnostic before production commit;
- targeted production head: `6216c60997801d10d36fa33670943d9ee39a3aa2`;
- final exact-head root CI remains the closing proof for this slice.
