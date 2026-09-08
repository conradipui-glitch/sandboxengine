# B12.1 — Release baseline and external smoke gate

Status: **ACCEPTED / GREEN**  
Base Engine commit: `5b438214f1d709dd43244f107f883f6b2fc5f6ac`  
Companion sandbox B11 production commit: `3d9cc885592ec229d2083883ea38d83de9fcc199`  
Accepted sandbox B12.1 merge: `a6d5db944960ab7c8672349e329e6ff9ba4ff649`

## Purpose

Start B12 from the exact published B11 state and close the first release-hardening gap without adding product functionality.

B12 is the release and operational-handoff block defined in `docs/SPECIFICATION.md`. This slice freezes the baseline, creates the durable release evidence ledger and adds an external read-only smoke gate for the already deployed companion `sandbox` Worker.

## Frozen B11 publication baseline

### Engine

- B11 PR #35 final head: `8d8d899e14a8d2ff56e9aac0e6ba94695738c194`;
- exact-head PR CI #681 / run `34237564459`: success;
- merge: `5b438214f1d709dd43244f107f883f6b2fc5f6ac`;
- published `main` CI #682 / run `34237754065`: success.

### Sandbox integration / production

- B11 integration merge: `3d9cc885592ec229d2083883ea38d83de9fcc199`;
- production deploy #49 / run `34238155592`: install, 49 tests, build and Wrangler deploy success;
- B11 Cloudflare version: `573525a6-4ff5-43d9-9642-62504eabb289`;
- rollout remained safe-by-default: missing/unexpected `ENGINE_FLORENCE_ROLLOUT` means `off`, and publication does not convert existing legacy sessions.

## Accepted external smoke

Companion `conradipui-glitch/sandbox` PR #11 added a bounded post-Wrangler read-only probe.

Exact accepted evidence:

- PR head: `401043e2a815e9ff4991bbaccb00c9c84b3bb399`;
- PR Verify #6 / run `34238768580`: success;
- merge: `a6d5db944960ab7c8672349e329e6ff9ba4ff649`;
- production deploy #50 / run `34239102418`: success;
- deployed Cloudflare version: `cd0d8948-86d3-4a56-9b5f-c97bbec79771`;
- `GET /api/health`: PASS, attempt 1;
- `GET /api/scenarios`: PASS, attempt 1;
- `GET /`: PASS, attempt 1.

The smoke is intentionally read-only: it creates no game session and no synthetic product-analytics event. Exhausting bounded retries/timeouts fails deployment rather than converting unavailability into success.

## Acceptance

- [x] Engine B12 branch started exactly from published B11 merge `5b438214f1d709dd43244f107f883f6b2fc5f6ac`;
- [x] sandbox smoke work started from published B11 production state;
- [x] smoke is read-only and bounded;
- [x] PR verification syntax-checks and executes the probe contract;
- [x] companion sandbox PR exact-head Verify is green;
- [x] companion PR is merged;
- [x] resulting `main` deployment runs smoke after Wrangler deploy and succeeds against deployed address;
- [x] `docs/RELEASE-REPORT.md` records the exact run/version.

## Non-goals retained

- this slice does not claim backup/restore, provider live eval or full acceptance-matrix completion by itself; those are separate B12 gates;
- it does not implement B13 Builder/repository/deployment orchestration;
- it does not enable Florence Engine rollout in production.

## Result

B12.1 is closed. Subsequent B12 evidence is tracked in `docs/RELEASE-REPORT.md`, `docs/B12-ACCEPTANCE-MATRIX.md` and `docs/RUNBOOK.md`.
