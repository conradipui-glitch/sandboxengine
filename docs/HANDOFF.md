# Передача работы

Обновлено: 2026-09-08

Текущий блок: **B12 — выпуск и эксплуатационная передача / B12.3 release security + quota/log gate**  
База Engine: published B11 merge `5b438214f1d709dd43244f107f883f6b2fc5f6ac`  
Ветка Engine: `b12-release-hardening` / PR #36  
Статус: **B12.1 + B12.2 accepted; B12.3 active**

## Published baseline

Engine B11:

- PR #35 exact-head CI #681 / `34237564459` — success;
- merge `5b438214f1d709dd43244f107f883f6b2fc5f6ac`;
- published main CI #682 / `34237754065` — success.

Sandbox production B12.1:

- smoke PR #11 head `401043e2a815e9ff4991bbaccb00c9c84b3bb399`, Verify #6 / `34238768580` — success;
- merge `a6d5db944960ab7c8672349e329e6ff9ba4ff649`;
- production deploy #50 / `34239102418` — success;
- Cloudflare version `cd0d8948-86d3-4a56-9b5f-c97bbec79771`;
- post-deploy `/api/health`, `/api/scenarios`, `/` all passed on attempt 1.

## B12.2 accepted evidence

`npm run verify` now includes `npm run drill:backup-restore`.

Exact implementation head `8113d7129544ad58aa0c628489d2415de78bf6d9`, CI #686 / run `34241997225` — success.

Release drill proved:

- SQLite online backup via Node `node:sqlite` backup API, not raw WAL-unsafe file copy;
- 11 pages backed up;
- clean restore of `session-1` at revision 1;
- exact pinned `release-1` and content hash preserved;
- one turn preserved;
- same idempotency key replays the committed response without a second mutation;
- all 12 Florence assets survive backup→restore and re-match SHA-256 manifest;
- source asset provenance remains pinned to `sandbox@092bcef0be5943e32bf02f08f9e9d4cde393fa95`.

The same CI reran durable restart/recovery cases: lost response replay, crash-before-commit rollback, lease reacquire, higher fencing token, stale commit rejection and bounded SQLite busy failure without partial publication.

Scope: standalone Engine SQLite + repository assets. This is not claimed as a Cloudflare Durable Object backup drill.

## B12.3 active blocker

During the same exact CI, `npm ci` reported **2 dependency vulnerabilities: 1 moderate and 1 high**. Functional green CI is therefore not enough for release acceptance.

Next actions:

1. run a reproducible dependency audit and capture exact packages/advisories;
2. classify each finding as runtime-reachable or dev/build-only;
3. upgrade/mitigate where compatible; any exception must be explicit and justified, never silently ignored;
4. add/record a release audit gate appropriate to the actual runtime surface;
5. consolidate existing quota/error/secret tests into `docs/RELEASE-REPORT.md` and add only missing release-sensitive checks;
6. renew exact-head `npm run verify` after changes.

After B12.3: bounded live provider eval + telemetry, acceptance-matrix consolidation, release docs/runbook/rollback, final RC/tag.

Do not begin B13 while B12 blockers remain open.
