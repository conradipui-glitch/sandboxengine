# Статус движка

Последнее обновление: 2026-09-09.

Ветка `feat/live-author-studio` завершила [L00–L09 — live authoring](tasks/LIVE-AUTHOR-COMPLETION.md). L00–L07 и L09 приняты; L08 — `UNVERIFIED: нет доступа к провайдеру`. Сквозной цикл через HTTP adapter, запуск frozen Player и браузерная приёмка пройдены; живой прогон реальной модели не заявляется. Следующий отдельный блок — B13 Builder.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B12 published** | B12 merge `3e6fcfd9c42910561500aca8c73e639d9bcf2f9b`; tag `v0.1.0` |
| Core/Runtime | **GREEN** | full deterministic suite + durable restart/replay/fencing |
| Storage/assets | **B12 GREEN / scoped** | online backup/restore + 12/12 Florence hashes; no Cloudflare DO claim |
| Studio/Player | **GREEN / live-authoring L00–L09 closed** | L00–L07 + L09 accepted; PR CI `34302849541` on reviewed code; L08 live model run UNVERIFIED |
| Releases/rollback | **GREEN** | permanent `drill:rollback`; exact B12 `main` CI #729 / `34251551857` |
| Persistent operations | **GREEN** | `npm start` + `/healthz` + SQLite + graceful SIGTERM |
| Security/quota | **GREEN** | permanent release audit 0/0 + 429 no-turn save integrity |
| Real quests | **B11 published** | Florence + Transfer Desk through generic Core/Runtime |
| Production companion | **B12.1 smoke GREEN** | `sandbox` production #50 / `34239102418` |
| Acceptance matrix | **B12 complete** | T01–33/T36–37 in `docs/B12-ACCEPTANCE-MATRIX.md` |
| Live provider evidence | **GREEN / model-quality limitation** | OpenRouter run `34250711595`, `deepseek/deepseek-v4-flash-0731`: contract 12/12, semantic 5/12, 16 attempts, mean 12.176 s, max 25.002 s |
| Codex live subscription | **UNAVAILABLE / documented** | deterministic T37 boundary green; no authenticated live App Server run claimed |
| Release | **`v0.1.0` published** | tag resolves exactly to `3e6fcfd9c42910561500aca8c73e639d9bcf2f9b`; main CI #729 success |
| B13 Builder/deployment | **B13.0–B13.c1 GREEN (adapters) / приёмка живых dispatch отдельно** | policy + read-only clone + bounded patch executor + authorized change set w/ exact-SHA CI check + preview adapter + production policy/lost-response reconciliation/verified rollback; live dispatches pending operator |
| M06 mission→site publication | **PARTIAL** | исправления F01–F07 доставлены на стенд (`7e61f98` engine / `db7cbe8` site) и hosted happy-path подтверждён; открыты live F01/F03, браузерный проход, C18 и повторный аудит. См. `docs/HANDOFF.md` |

## M06 publication route — текущее состояние (2026-09-11)

Независимая проверка зафиксировала семь дефектов; шесть исправлены локально с регрессионными тестами:

- **F01/F02/F03 (P1)** — `5475da0`: публичный контент и открытые сессии разрешаются по неизменяемому `contentRevision`, публикация новой ревизии перекрепляет каталог, каталог пишется до release pointer с компенсирующим откатом, unpublish блокирует только новые запуски.
- **F04 (P1)** — site `f7f1233`: финал сохраняется в binding, GET реконсилируется с движком.
- **F05/F06 (P1/P2)** — site `db7cbe8` + engine `8ebe741`: авторский frame (фон, слои, диалоги, варианты, финал) строится из pinned-ревизии и рендерится общим mission renderer; published namespace не уходит в legacy, сбой каталога даёт 5xx, legacy-карточки остаются в каталоге; ассеты pinned-ревизии отдаются публично.
- **F07 (P1) — исправлено (`83f5cbf`) и подтверждено hosted**: authored-runtime стал supervised compose-сервисом `lhc-authored` с собственным healthcheck на `127.0.0.1:8746/healthz`; конфигурация вынесена из `/tmp` в `deploy/vps/.env` (0600). Проверено на стенде: пересоздание engine больше не теряет runtime, `docker restart lhc-authored` → healthy.

M06 не считается завершённым: hosted happy-path подтверждён (создание игры, два хода, финал, reload, 404 на неизвестную ссылку, каталог аддитивен), но живые F01/F03 (правка черновика и unpublish при открытой сессии), браузерный проход глазами игрока, C18 и повторный независимый аудит — открыты.

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

[B13](tasks/B13-BUILDER.md) принят на уровне адаптеров (B13.0–B13.c1): живые preview/production dispatch — отдельные шаги приёмки по разрешению оператора. B13 не меняет опубликованные доказательства `v0.1.0`.
