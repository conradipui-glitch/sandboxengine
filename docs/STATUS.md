# Статус движка

Последнее обновление: 2026-09-09.

Текущая работа в `feat/live-author-studio`: [L00–L09 — завершение live authoring](tasks/LIVE-AUTHOR-COMPLETION.md). L00–L07 приняты; L08 — `UNVERIFIED: нет доступа к провайдеру`; L09 — финализация. Сквозной цикл через HTTP adapter и браузерная приёмка пройдены; живой прогон реальной модели не заявляется.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B12 published** | B12 merge `3e6fcfd9c42910561500aca8c73e639d9bcf2f9b`; tag `v0.1.0` |
| Core/Runtime | **GREEN** | full deterministic suite + durable restart/replay/fencing |
| Storage/assets | **B12 GREEN / scoped** | online backup/restore + 12/12 Florence hashes; no Cloudflare DO claim |
| Studio/Player | **GREEN / live-authoring L00–L07 accepted** | historical author/playtest/publication paths + T29 smoke `34246143800`; real-HTTP e2e cycle, browser desktop+360px acceptance, provider settings lifecycle; L08 live model run UNVERIFIED |
| Releases/rollback | **GREEN** | permanent `drill:rollback`; exact B12 `main` CI #729 / `34251551857` |
| Persistent operations | **GREEN** | `npm start` + `/healthz` + SQLite + graceful SIGTERM |
| Security/quota | **GREEN** | permanent release audit 0/0 + 429 no-turn save integrity |
| Real quests | **B11 published** | Florence + Transfer Desk through generic Core/Runtime |
| Production companion | **B12.1 smoke GREEN** | `sandbox` production #50 / `34239102418` |
| Acceptance matrix | **B12 complete** | T01–33/T36–37 in `docs/B12-ACCEPTANCE-MATRIX.md` |
| Live provider evidence | **GREEN / model-quality limitation** | OpenRouter run `34250711595`, `deepseek/deepseek-v4-flash-0731`: contract 12/12, semantic 5/12, 16 attempts, mean 12.176 s, max 25.002 s |
| Codex live subscription | **UNAVAILABLE / documented** | deterministic T37 boundary green; no authenticated live App Server run claimed |
| Release | **`v0.1.0` published** | tag resolves exactly to `3e6fcfd9c42910561500aca8c73e639d9bcf2f9b`; main CI #729 success |
| B13 Builder/deployment | **next block / not started** | starts only from accepted B12; separate acceptance |

## Published B12 result

B12 is accepted and published as `v0.1.0`.

Exact release evidence:

- PR #36 merge: `3e6fcfd9c42910561500aca8c73e639d9bcf2f9b`;
- published `main` CI: #729 / run `34251551857` — success;
- release tag: `v0.1.0` → exact B12 merge SHA;
- tag workflow: `34251761663` — success;
- temporary tag-branch cleanup: `34251870134` — success; temporary branch removed;
- temporary live/browser/write workflows are absent from `main`.

The selected live model `deepseek/deepseek-v4-flash-0731` passed every structural contract case but scored 5/12 (41.7%) on the small semantic corpus. This is a model-quality limitation, not proof that the model is recommended for intent parsing. Provider token usage was incomplete, so aggregate token count remains `null`.

Operational commands and limitations: `docs/RUNBOOK.md`. Canonical evidence: `docs/RELEASE-REPORT.md`.

## Next block

Сначала L00–L09 по текущему handoff. B13 — Builder/code/GitHub/deployment orchestration — остаётся отдельным последующим блоком и не меняет опубликованные доказательства `v0.1.0`.
