# B13.a2 continuation — real sandbox writer + verifier + acceptance

Status: B13.a2 has a contract layer (bounded-patch-job / bounded-agent-job, CI green on 267fdaa) but the
worklog honestly says: no real filesystem sandbox writer, no real verification runner. This file is the
implementation plan for the real executor layer.

## Constraints (from B13-BUILDER.md §Граница блока)

- Builder is a separate process from Core/Runtime. An isolated Git folder is NOT a sandbox by itself.
- Sandbox for running verification commands is REQUIRED before claiming B13.a2 accepted.
- No push, PR, workflow, deployment in a2. No Docker socket, host root, game SQLite or secrets access.
- Docker/Podman absent on this Windows host; WSL2 broken (Wsl/CallMsi/E_ACCESSDENIED — MSI repair denied,
  needs admin, not available). So the sandbox must be built from Node-level primitives on Windows:
  - clean environment (no inherited secrets) — pattern already exists in readonly-workspace.ts
    isolatedGitEnvironment();
  - no shell: execFile with fixed argv only;
  - PATH restricted to System32 + pinned Node dir, so `npm`/`node` resolve but arbitrary tools do not;
  - cwd pinned to the isolated checkout; timeout + maxBuffer on every spawn;
  - PATH is NOT a security boundary by itself — say so honestly; it is hygiene. The real boundary for a2
    remains: policy allowlist for WHAT is executed, isolated clone for WHERE it runs, no network-bearing
    credentials in the environment.

## Task breakdown

1. `apps/builder-runner/src/workspace-executor.ts`:
   - `createMutableBuilderWorkspace(policy)` — extends readonly adapter with `writeText` (policy write
     authorization + realpath containment + size cap) and `treeIdentity()` (`git write-tree` after
     `git add -A -- <allowed paths>` restricted to writable prefixes, fixed argv, isolated env).
   - `treeIdentity` must be deterministic: `git add -A`, then `git write-tree`; result 40-hex SHA.
2. `apps/builder-runner/src/verification-runner.ts`:
   - `createPolicyVerificationRunner(policy)` — runs ONLY policy.verificationCommands, executable must be
     a basename matching the policy entry exactly; spawn via execFile with the isolated environment;
     timeout 120s, maxBuffer 1 MiB; captures exit code; non-zero → typed error `verification_failed`
     with the failing command name (no stderr dump into the error — bounded summary only).
3. Tests `apps/builder-runner/test/workspace-executor.test.mjs`:
   - real fixture repo (reuse fixtureRepository pattern): patch allowed file → treeIdentity changes
     deterministically (same writes → same tree hash); writing outside writable prefix fails
     `path_not_allowed`; .git write fails; tree hash equals `git write-tree` from a second manual clone
     with same content (cross-check identity).
   - verification runner: allowed command runs; command not in policy → typed rejection; failing command
     → `verification_failed`.
4. Update `bounded-agent-job.ts` consumers: keep contract, wire to real workspace in test.
5. Worklog `docs/worklog/2026-09-09-B13-a2-workspace-executor.md` + HANDOFF/STATUS/task card updates.
6. Verify: `npm run test:builder`, then `npm run verify` full, commit, push (push is allowed: B13.b1 card
   grants commit/push authority — but a2 itself may push branch updates per PR flow already in use;
   PR #38 exists and push to its branch is the established practice from B13.0/a1).
