# Living History Engine — operational runbook

Updated: 2026-09-08  
Scope: standalone Node 24 + SQLite Engine. Companion Cloudflare Worker operations are explicitly separate.

## 1. Supported prerequisites

- Node.js `24.19.0` from `.nvmrc`;
- npm lockfile installation via `npm ci`;
- local filesystem suitable for SQLite. Do not place the same SQLite database on a shared network filesystem and treat it as a supported multi-writer cluster.

## 2. Clean release verification

```bash
npm ci
npm run build
npm run verify
```

Root verify currently includes:

- dependency security audit;
- all deterministic package/app regression suites;
- `drill:backup-restore`;
- `drill:rollback`;
- `drill:startup-shutdown`;
- architectural boundary checks;
- documentation/generation gate.

External live-provider evaluation is intentionally not part of this command because it can require paid credentials.

## 3. Local authoring mode

```bash
npm run dev:studio
```

Studio and its local Control proxy bind to loopback. The dev author assistant is a deterministic scripted no-tools backend, useful for the authoring workflow but not live-model evidence.

The onboarding/help path is static and works without AI. B12 browser evidence exercised it at 360×800 with real keyboard/focus interactions.

## 4. Persistent Runtime + Control

Build first:

```bash
npm run build
```

Then start:

```bash
RUNTIME_DB_PATH=./data/runtime.sqlite \
HOST=127.0.0.1 \
PORT=8787 \
CONTROL_AUTH_MODE=local \
CONTROL_PORT=8788 \
npm start
```

Defaults are `./data/runtime.sqlite`, Runtime `127.0.0.1:8787`, Control `127.0.0.1:8788`, and local Control auth mode.

### Authenticated Control

`CONTROL_AUTH_MODE=authenticated` enables the authenticated Control composition. Bootstrap credentials must be supplied **all together or not at all**:

- `CONTROL_BOOTSTRAP_USER_ID`;
- `CONTROL_BOOTSTRAP_USERNAME`;
- `CONTROL_BOOTSTRAP_PASSWORD`.

For non-loopback authenticated Control, the server additionally requires:

- `CONTROL_SECURE_COOKIES=true`;
- at least one `CONTROL_ALLOWED_ORIGINS` value;
- explicit `CONTROL_HOST`.

Local mode refuses non-loopback Control binding.

## 5. Health and readiness

Runtime liveness/readiness probe:

```bash
curl --fail http://127.0.0.1:8787/healthz
```

Expected JSON:

```json
{"status":"ok","apiVersion":"v1"}
```

Control has no separate `/healthz` contract in B12. Its successful startup is logged and bounded safe endpoints are covered by tests/drills; do not invent a Control health API in deployment configuration.

Permanent startup/shutdown release proof:

```bash
npm run drill:startup-shutdown
```

This starts the real persistent entrypoint on ephemeral loopback ports, checks Runtime health plus a safe Control read, verifies SQLite creation, sends SIGTERM and requires clean exit code 0.

## 6. Graceful shutdown

Send SIGTERM or SIGINT to the Node process. The entrypoint stops Control/Runtime listeners and closes SQLite-backed stores before exit.

For operator maintenance, wait for the process to exit before manipulating the live database file. Do not kill during a planned offline backup unless forced by an incident.

## 7. Backup and restore

Release regression:

```bash
npm run drill:backup-restore
```

The drill uses SQLite's online backup API and proves restored session revision, pinned release, turn history/idempotent replay and 12 Florence repository asset hashes.

For a simple offline operator backup of the persistent entrypoint:

1. send SIGTERM and wait for clean exit;
2. copy the closed `RUNTIME_DB_PATH` file to versioned backup storage;
3. preserve the exact application/repository revision supplying immutable assets and code;
4. restart and check `/healthz`.

Restore is the inverse while the service is stopped: preserve the failed/current DB separately, replace it with the selected backup, start the same compatible release, check `/healthz`, then perform bounded application reads before reopening traffic.

Do **not** copy only a live WAL-mode main DB file and call that an online backup. Do **not** interpret this procedure as Cloudflare Durable Object backup support.

## 8. Release publication rollback

Permanent proof:

```bash
npm run drill:rollback
```

The tested invariant is:

- publication changes the current release pointer for **future sessions**;
- sessions created before a later publication remain pinned to their exact immutable release;
- rollback moves the current pointer to a previously published release;
- sessions already pinned to the newer release continue using it;
- after process/repository-store restart, the pointer, bindings, immutable hashes and publication history remain intact.

Therefore rollback is not session migration. Never rewrite existing session bindings as part of ordinary release rollback.

## 9. Dependency/security gate

```bash
npm run audit:release
```

Moderate/high/critical findings in the full dependency graph block the current B12 release policy. Production graph counts are reported separately.

## 10. AI provider evaluation and quotas

Live eval is opt-in:

```bash
LHE_EVAL_API_KEY='...' \
LHE_EVAL_MODEL='provider/model' \
LHE_EVAL_BASE_URL='https://openrouter.ai/api/v1' \
npm run eval:ai
```

`LHE_EVAL_BASE_URL` is optional. Without required key+model the evaluator returns `status: not_configured` and makes no live claim.

When configured it records bounded case status, latency, attempts, provider-reported token usage, model ID and provider request IDs. Unknown provider usage remains `null`, not zero.

Runtime provider HTTP 429/rate-limit failures are tested as bounded replayable no-turn outcomes and do not mutate the save.

The persistent `npm start` entrypoint does **not** automatically compose a live provider in B12; provider integration must be explicit rather than inferred from an environment key.

## 11. Logs

The standalone process writes startup and ordinary process diagnostics to stdout/stderr. Public HTTP/provider errors are sanitized by tested boundaries.

B12 does not ship a built-in log rotation daemon. Production supervisors/platforms must provide retention/rotation for stdout/stderr. Do not store raw credentials in log configuration or command-line URLs.

## 12. Companion production Worker

The `conradipui-glitch/sandbox` B12.1 deployment has a post-deploy read-only smoke for `/api/health`, `/api/scenarios` and `/`.

That smoke does not create sessions and does not enable Florence Engine rollout. `ENGINE_FLORENCE_ROLLOUT` remains a separate operational switch; existing legacy sessions are not converted by changing it.

## 13. Incident checklist

1. stop new operational changes; keep the exact affected commit/release ID;
2. check Runtime `/healthz` and deployment/process logs;
3. if SQLite/storage integrity is suspected, stop the process before offline file replacement;
4. prefer release-pointer rollback for a bad published quest/release rather than rewriting active sessions;
5. preserve failed DB/log evidence before restore;
6. rerun the smallest relevant drill/regression and then root `npm run verify` before declaring recovery complete;
7. record any live-provider/Codex evidence as unavailable when the required account/credential is absent.

## 14. Release limitations

- no B13 Builder/deployment orchestration;
- no Cloudflare DO backup claim;
- no live-provider/Codex success claim without a real configured run;
- no shared-network SQLite multi-writer guarantee;
- no built-in log rotation;
- no automatic paid API fallback from subscription/Codex paths.

## 15. VPS compose services (M06/R04 candidate)

`deploy/vps/docker-compose.yml` defines four services on the same SQLite volume:

| Service | Container | Ports | Healthcheck |
|---|---|---|---|
| `engine` | `lhc-engine` | 8742 (runtime), 8788 (control, loopback) | `http://127.0.0.1:8742/healthz` |
| `authored` | `lhc-authored` | 8746 (legacy authored runtime) | `http://127.0.0.1:8746/healthz` |
| `studio` | `lhc-studio` | 8740, 8745 | — |
| `gate` | `lhc-gate` | 8744 | — |

nginx front: 8743 → `/public/v1/missions*` to control 8788, `/` to authored 8746; 8741 → Studio.

Configuration:

- secrets live in `deploy/vps/.env` (not committed) and are injected with `--env-file`:
  `docker compose --env-file deploy/vps/.env -f deploy/vps/docker-compose.yml up -d <service>`;
- `LH_PUBLIC_MISSION_SESSION_SECRET` is required by `engine` for public mission sessions. Do not place it in `/tmp` overrides: the file would be world-readable and would not survive a reboot;
- `authored` uses `SQLitePublishedSessionBindingStore`, so a container restart no longer drops already started legacy authored sessions.

Delivered state (2026-09-11): `/opt/lhc/engine` is at `7e61f9889724f01a5f5c1c2e511093c177ceac6b`; `lhc-engine`, `lhc-authored`, `lhc-studio` and `lhc-gate` are healthy; the legacy `/tmp/lhc-m06-compose-override.yml` override is removed and the public session secret lives only in `deploy/vps/.env` (mode 600).

Recovery procedure after recreating a container:

1. `docker compose --env-file deploy/vps/.env -f deploy/vps/docker-compose.yml up -d` (start/reconcile all services);
2. verify each healthcheck: `docker ps --filter name=lhc- --format '{{.Names}} {{.Status}}'` must show `(healthy)` for `lhc-engine` and `lhc-authored`;
3. smoke the public routes: `curl -fsS https://<host>:8743/healthz`, `curl -fsS https://<host>:8743/public/v1/missions`;
4. smoke Studio: `curl -fsS -o /dev/null -w '%{http_code}' https://<host>:8741/`;
5. resolve an existing legacy authored session by id to confirm bindings survived.

Rollback: keep the previous image tags and the previous `deploy/vps/.env`; recreate the affected service with the earlier compose file revision. Do not rewrite active sessions — prefer release-pointer rollback for a bad published release.
