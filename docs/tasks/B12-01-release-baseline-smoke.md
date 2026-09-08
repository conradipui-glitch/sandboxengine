# B12.1 — Release baseline and external smoke gate

Status: **in progress**  
Base Engine commit: `5b438214f1d709dd43244f107f883f6b2fc5f6ac`  
Companion sandbox production commit: `3d9cc885592ec229d2083883ea38d83de9fcc199`

## Purpose

Start B12 from the exact published B11 state and close the first release-hardening gap without adding product functionality.

B12 is the release and operational-handoff block defined in `docs/SPECIFICATION.md`. It must prove clean installation/build/regression, bounded provider evaluation, backup/restore, restart/quota/log behavior, release documentation, rollback and an external smoke of any network deployment. B13 Builder/deployment orchestration is explicitly out of scope.

This slice covers only:

1. frozen published B11 baseline;
2. durable release-report structure for later B12 evidence;
3. an external **read-only** smoke gate for the already deployed `sandbox` production Worker.

## Frozen B11 publication baseline

### Engine

- B11 PR: `conradipui-glitch/sandboxengine#35`;
- final PR head: `8d8d899e14a8d2ff56e9aac0e6ba94695738c194`;
- exact-head PR CI #681 / run `34237564459`: success;
- merge SHA: `5b438214f1d709dd43244f107f883f6b2fc5f6ac`;
- published `main` CI #682 / run `34237754065`: success.

### Sandbox integration / production

- B11 PR: `conradipui-glitch/sandbox#10`;
- verified PR head: `5480c77a59912f435c3f9d1bafc2985c23fbe531`;
- Verify #5 / run `34236822232`: tests + build success;
- merge SHA: `3d9cc885592ec229d2083883ea38d83de9fcc199`;
- production deploy #49 / run `34238155592`: install, 49 tests, build and Wrangler deploy success;
- deployed Worker: `living-history-sandbox`;
- deployed Cloudflare version: `573525a6-4ff5-43d9-9642-62504eabb289`;
- deployment output includes `HistorySession`, `ProductAnalytics` and `RuntimeRouteSession` Durable Object bindings.

B11 rollout remains safe-by-default: missing or unexpected `ENGINE_FLORENCE_ROLLOUT` is `off`; no existing legacy session is converted by the B11 publication.

## External smoke design

Companion branch/PR in `conradipui-glitch/sandbox` adds a post-Wrangler smoke probe.

The probe is intentionally read-only so deploys do not create artificial sessions or contaminate product analytics:

- `GET /api/health` must identify a healthy `living-history-sandbox` service;
- `GET /api/scenarios` must contain both `florence-workshop` and `russia-1917`;
- `GET /` must return the expected deployed HTML application shell.

Each request has bounded retries and a bounded request timeout. Exhausting attempts fails the deploy workflow rather than converting an unavailable deployment into success.

## Acceptance for this slice

B12.1 is accepted only when all are true:

- [x] Engine branch starts exactly from published B11 merge `5b438214f1d709dd43244f107f883f6b2fc5f6ac`;
- [x] sandbox smoke branch starts exactly from published B11 production merge `3d9cc885592ec229d2083883ea38d83de9fcc199`;
- [x] smoke is read-only and bounded;
- [x] PR verification syntax-checks the smoke probe;
- [ ] companion sandbox PR exact-head Verify is green;
- [ ] companion PR is merged;
- [ ] the resulting `main` deployment executes the smoke step after Wrangler deploy and succeeds against the deployed address;
- [ ] `docs/RELEASE-REPORT.md` records that exact run and Cloudflare version.

## Explicit non-goals

- backup/restore drill — next B12 slice;
- provider live eval — later bounded B12 slice with explicit budget and provider status;
- full T01–33/T36–37 evidence audit — assembled after the independent release checks are complete;
- Builder, repository agent execution or deployment orchestration — B13;
- enabling Florence Engine rollout in production — separate release decision, not implied by this smoke gate.

## Next step after acceptance

Run the B12 backup/restore + restart drill from a clean checkout and record immutable evidence in `docs/RELEASE-REPORT.md`. Do not begin B13.
