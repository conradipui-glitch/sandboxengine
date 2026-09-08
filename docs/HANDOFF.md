# Передача работы

Обновлено: 2026-09-08

Текущий блок: **B12 — выпуск и эксплуатационная передача / B12.4 bounded live provider eval**  
База Engine: published B11 merge `5b438214f1d709dd43244f107f883f6b2fc5f6ac`  
Ветка Engine: `b12-release-hardening` / PR #36  
Статус: **B12.1 + B12.2 + B12.3 accepted; B12.4 active**

## Published baseline

Engine B11:

- PR #35 exact-head CI #681 / `34237564459` — success;
- merge `5b438214f1d709dd43244f107f883f6b2fc5f6ac`;
- published main CI #682 / `34237754065` — success.

Sandbox B12.1:

- smoke PR #11 head `401043e2a815e9ff4991bbaccb00c9c84b3bb399`, Verify #6 / `34238768580` — success;
- merge `a6d5db944960ab7c8672349e329e6ff9ba4ff649`;
- production deploy #50 / `34239102418` — success;
- Cloudflare version `cd0d8948-86d3-4a56-9b5f-c97bbec79771`;
- `/api/health`, `/api/scenarios`, `/` passed after deploy on attempt 1.

## B12.2 accepted

Root verify contains the reproducible SQLite/assets restore drill. It proves online backup, clean restore, exact session/release/revision preservation, idempotent replay, 12/12 Florence asset hashes and the existing restart/fencing/busy recovery cases.

Scope is standalone Engine SQLite + repository assets, not Cloudflare Durable Object backup.

## B12.3 accepted

Exact accepted implementation head: `6f5588b2d88870f89a002b6db84867e1b6a3bc41`.  
PR #36 CI #698 / run `34243238408` — success.

Security/remediation:

- initial dev/build findings were `ajv@8.17.1` moderate + transitive `fast-uri@3.1.0` high;
- updated to `ajv@8.20.0` and `fast-uri@3.1.7`;
- temporary lock-refresh workflow with contents write was removed before accepted head;
- `npm ci` now reports 0 known vulnerabilities;
- permanent `npm run audit:release` is part of root verify and requires no moderate/high/critical finding in the full graph;
- exact accepted run reports full graph 0 and production graph 0.

Quota/error/save integrity:

- new B12 regression uses two retryable provider HTTP 429 responses;
- Runtime completes a replayable `INTENT_FAILED` no-turn;
- revision, game time, resources/state and persisted turn count remain unchanged;
- same idempotency key does not call the provider again;
- prepared authored option remains usable and commits normally afterwards.

Scope note: this proves upstream provider quota/rate-limit failure integrity. It does not invent a separate local project billing quota subsystem.

Existing exact-run tests additionally cover quota zero/null/stale semantics, inference-vs-management credential separation, provider error sanitization, safe connection views, secret-free exports/task packages/playtest evidence and project/session access isolation.

## B12.4 active — exact next action

Existing command: `npm run eval:ai`.

Live configuration is explicit only:

- `LHE_EVAL_API_KEY` — required;
- `LHE_EVAL_MODEL` — required;
- `LHE_EVAL_BASE_URL` — optional, OpenRouter-compatible default;
- `LHE_EVAL_OUTPUT` — optional report path.

When configured the eval records per-case contract/semantic status, latency, attempts, provider usage/token counts, model ID and provider request IDs for a bounded intent+narrative corpus.

Next sequence:

1. determine through a bounded CI eval job whether the release environment has the explicit eval credential/model;
2. never print or probe the secret itself;
3. if configured, run exactly one bounded live eval and preserve the JSON report as release evidence;
4. if not configured, preserve the script's explicit `status: not_configured` and state live provider evidence as unavailable — do not substitute fake-provider tests;
5. record exact model/provider, case pass rates, attempts/tokens/latency or the precise unavailable status in `docs/RELEASE-REPORT.md`;
6. renew exact-head root CI after the report changes.

After B12.4: acceptance-matrix consolidation → release README/runbook/changelog + rollback drill → final RC/tag.

Do not begin B13 while B12 blockers remain open.
