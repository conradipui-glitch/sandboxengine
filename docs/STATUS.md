# Статус движка

Последнее обновление: 2026-09-08.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B11 published; B12 in progress** | B11 Engine merge `5b438214f1d709dd43244f107f883f6b2fc5f6ac`; published main CI #682 / `34237754065` success |
| Контракты/Core | **published through B11** | generic conditions/effects/authored cases; Core boundary tests reject quest-specific identities |
| Runtime storage/API | **B12.2 restore/restart GREEN** | SQLite backup/restore + durable recovery are part of root verify |
| Authoring / Control / Studio | **published through B10/B11 integration** | draft history/restore, release/publication, access controls, author assistant and playtest path |
| Presentation/assets/Player | **B12.2 asset restore GREEN** | 12/12 Florence binaries survive backup→restore and re-match pinned SHA-256 manifest |
| Plugins | **B08 published** | trusted manifest/registry/execution + artifact-bound plugin evidence |
| Real quests | **B11 published** | Florence + Transfer Desk use shared Core without quest-ID branches; semantic acceptance proved |
| Sandbox production integration | **B12.1 external smoke GREEN** | production #50 / `34239102418`; Cloudflare version `cd0d8948-86d3-4a56-9b5f-c97bbec79771` |
| Release security/quota | **B12.3 accepted** | head `6f5588b2d88870f89a002b6db84867e1b6a3bc41`; CI #698 / `34243238408`; dependency audit 0/0; 429 save-integrity regression GREEN |
| Release hardening | **B12.1–B12.3 accepted; B12.4 active** | next: bounded live provider eval + attempts/token/latency statement |
| Builder/deployment product | **B13 not started** | explicitly outside B12 release acceptance |

## B12.1 accepted — external production smoke

Production workflow #50 / run `34239102418` passed after merge `a6d5db944960ab7c8672349e329e6ff9ba4ff649`:

- install, tests and build — PASS;
- Wrangler deploy — PASS;
- deployed Cloudflare version `cd0d8948-86d3-4a56-9b5f-c97bbec79771`;
- `/api/health`, `/api/scenarios`, `/` — PASS on attempt 1.

The smoke is read-only and creates no game session or synthetic product analytics.

## B12.2 accepted — backup/restore + restart/recovery

Root `npm run verify` includes `npm run drill:backup-restore`.

Accepted evidence includes:

- SQLite online backup: 11 pages;
- clean restore of `session-1` at revision 1 with pinned release/content hash;
- exactly one turn preserved and retry remains idempotent;
- 12/12 Florence assets restored and SHA-256 checked;
- lost-response replay, crash-before-commit rollback, lease reacquire, fencing and busy-policy atomicity remain green.

Scope: standalone Engine SQLite + repository assets; no Cloudflare Durable Object backup claim.

## B12.3 accepted — release security / quota / logs

Exact implementation head `6f5588b2d88870f89a002b6db84867e1b6a3bc41`, PR #36 CI #698 / run `34243238408` — success.

Dependency blocker was fixed rather than waived:

- `ajv` upgraded from 8.17.1 to 8.20.0;
- transitive `fast-uri` refreshed to 3.1.7;
- temporary contents-write refresh workflow was deleted before accepted head;
- `npm ci` reports 0 known vulnerabilities;
- permanent `audit:release` reports 0 vulnerabilities in both full and production graphs and is part of root verify.

Release-sensitive Runtime regression also proves two upstream provider HTTP 429 failures produce a bounded replayable no-turn result: revision/time/resources/turns remain unchanged, retry does not call the provider again, and a prepared authored action still commits afterwards.

Existing exact-run tests continue to prove quota zero/null/stale semantics, management-vs-inference separation, safe error normalization, secret-free exports/task packages/traces and public/project isolation.

## B12.4 active — bounded live provider eval

`npm run eval:ai` already requires explicit `LHE_EVAL_API_KEY` + `LHE_EVAL_MODEL` and records semantic/contract result, latency, attempts and provider-reported tokens. It is intentionally not part of ordinary verify because it is external and potentially paid.

Next operation: determine whether the release CI environment actually has an explicitly configured eval credential/model. If yes, run one bounded live eval and record exact model/provider/usage/latency. If no, record `not_configured` as the honest live-evidence status and continue with deterministic evidence without pretending it is a live model run.

Canonical ledger: `docs/RELEASE-REPORT.md`.

Do not begin B13 while B12 release blockers remain open.
