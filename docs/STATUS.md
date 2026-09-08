# Статус движка

Последнее обновление: 2026-09-08.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B11 published; B12 release candidate hardening** | B11 merge `5b438214f1d709dd43244f107f883f6b2fc5f6ac`; B12 PR #36 |
| Core/Runtime | **GREEN** | full deterministic suite + durable restart/replay/fencing |
| Storage/assets | **B12 GREEN / scoped** | online backup/restore + 12/12 Florence hashes; no Cloudflare DO claim |
| Studio/Player | **GREEN** | author/playtest/publication paths + T29 real 360×800 keyboard/focus smoke `34246143800` |
| Releases/rollback | **GREEN** | permanent `drill:rollback`; CI #709 and #713 |
| Persistent operations | **GREEN** | `npm start` + `/healthz` + SQLite + graceful SIGTERM; CI #713 / `34246765104` |
| Security/quota | **GREEN** | permanent release audit 0/0 + 429 no-turn save integrity |
| Real quests | **B11 published** | Florence + Transfer Desk through generic Core/Runtime |
| Production companion | **B12.1 smoke GREEN** | `sandbox` production #50 / `34239102418` |
| Acceptance matrix | **consolidated** | T01–33/T36–37 in `docs/B12-ACCEPTANCE-MATRIX.md`; T29 gap closed |
| Live provider evidence | **BLOCKED / not_configured** | run `34243952551`: no `LHE_EVAL_API_KEY` + `LHE_EVAL_MODEL`; no fake live claim |
| Codex live subscription | **UNAVAILABLE** | deterministic T37 boundary green; no authenticated live App Server run claimed |
| B13 Builder/deployment | **not started** | outside B12 |

## Current B12 position

All autonomous functional/operational release gates found so far are closed: external production smoke, dependency remediation, backup/restore, restart recovery, quota-save integrity, mobile keyboard/onboarding, durable release rollback and persistent startup/shutdown.

Latest full regression before this documentation sync: exact implementation head `847aa22f3e4457bccd5c4dc19ab6d27f26941afb`, CI #713 / run `34246765104` — success.

## Remaining blocker

B12 specification requires a bounded live provider eval and attempt/token/latency release statement. The real evaluator was invoked in CI but returned `status: not_configured`; the release environment contains no explicit key/model. Until a real configured bounded run is recorded, the B12 tag remains intentionally absent.

Operational commands and limitations: `docs/RUNBOOK.md`. Canonical evidence: `docs/RELEASE-REPORT.md`.

Do not start B13 or create the B12 tag while the live-provider gate is unresolved.
