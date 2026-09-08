# Статус движка

Последнее обновление: 2026-09-08.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B11 published; B12 mandatory gates complete** | B11 merge `5b438214f1d709dd43244f107f883f6b2fc5f6ac`; B12 PR #36 |
| Core/Runtime | **GREEN** | full deterministic suite + durable restart/replay/fencing |
| Storage/assets | **B12 GREEN / scoped** | online backup/restore + 12/12 Florence hashes; no Cloudflare DO claim |
| Studio/Player | **GREEN** | author/playtest/publication paths + T29 real 360×800 keyboard/focus smoke `34246143800` |
| Releases/rollback | **GREEN** | permanent `drill:rollback`; CI #709 and #713 |
| Persistent operations | **GREEN** | `npm start` + `/healthz` + SQLite + graceful SIGTERM; CI #713 / `34246765104` |
| Security/quota | **GREEN** | permanent release audit 0/0 + 429 no-turn save integrity |
| Real quests | **B11 published** | Florence + Transfer Desk through generic Core/Runtime |
| Production companion | **B12.1 smoke GREEN** | `sandbox` production #50 / `34239102418` |
| Acceptance matrix | **mandatory B12 evidence complete** | T01–33/T36–37 in `docs/B12-ACCEPTANCE-MATRIX.md` |
| Live provider evidence | **GREEN / model-quality limitation** | OpenRouter run `34250711595`, `deepseek/deepseek-v4-flash-0731`: contract 12/12, semantic 5/12, 16 attempts, mean 12.176 s, max 25.002 s |
| Codex live subscription | **UNAVAILABLE / documented** | deterministic T37 boundary green; no authenticated live App Server run claimed |
| B13 Builder/deployment | **not started** | outside B12 |

## Current B12 position

All mandatory B12 functional, operational and external provider evidence is now present. External production smoke, dependency remediation, backup/restore, restart recovery, quota-save integrity, mobile keyboard/onboarding, durable release rollback, persistent startup/shutdown and one real compatible-provider eval are recorded.

The selected live model `deepseek/deepseek-v4-flash-0731` passed every structural contract case but scored 5/12 (41.7%) on the small semantic corpus. This is recorded as a model-quality limitation, not hidden and not treated as proof that this model is the recommended intent parser. Narrative cases passed 4/4; aggregate token usage remains `null` because the provider did not report complete usage for every case.

The one-shot workflow that referenced the repository API secret has been deleted after evidence capture. No credential-bearing eval workflow is intended to ship.

## Final publication sequence

1. run final exact-head `npm run verify` + docs gate on the cleaned B12 head;
2. make PR #36 ready and merge only that exact green head;
3. verify `main` CI on the merge commit;
4. create the concrete B12 release tag on the verified merge commit;
5. only then begin B13.

Operational commands and limitations: `docs/RUNBOOK.md`. Canonical evidence: `docs/RELEASE-REPORT.md`.
