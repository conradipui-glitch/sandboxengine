# Передача работы

Обновлено: 2026-09-08

Текущий блок: **B12 published / B13 next**  
Release: `v0.1.0`  
B12 merge: `3e6fcfd9c42910561500aca8c73e639d9bcf2f9b`  
Published `main` CI: #729 / `34251551857` — success

## B12 завершён

- B12.1 companion production external smoke: deploy run `34239102418`, Cloudflare version `cd0d8948-86d3-4a56-9b5f-c97bbec79771`;
- B12.2 SQLite online backup/restore + 12/12 Florence assets + restart recovery;
- B12.3 dependency audit 0/0 + provider 429 no-turn save integrity;
- B12.4 real OpenRouter provider eval: run `34250711595`, model `deepseek/deepseek-v4-flash-0731`, structural contract 12/12, semantic 5/12, 16 attempts, mean latency 12,176 ms, max 25,002 ms; aggregate token usage `null` because telemetry was incomplete;
- B12.5 real Chromium T29 mobile/focus/keyboard smoke: run `34246143800` PASS;
- B12.6 permanent release rollback drill: r1→r2→rollback r1 + restart/session pinning;
- B12.7 persistent Node+SQLite `npm start`, real health/control probes and graceful SIGTERM;
- T01–33/T36–37 matrix consolidated;
- README/runbook/changelog are release-facing;
- final cleaned PR head `abf23383e2e70b80aa6c029da17c6e5ab0a66361`, CI #728 / `34251382755` — success;
- PR #36 merged as `3e6fcfd9c42910561500aca8c73e639d9bcf2f9b`;
- `main` CI #729 / `34251551857` — success;
- tag `v0.1.0` verified at the exact merge SHA;
- temporary tag branch removed by run `34251870134`.

## Live-provider interpretation

The real compatible-provider/contract boundary is accepted, but the selected model is not qualified as the recommended intent-understanding model: semantic score was 5/12 (41.7%) despite 12/12 contract safety. All four narrative cases passed. Provider usage telemetry was incomplete, so total tokens remain `null` rather than guessed.

The API key existed only as a GitHub Actions Secret. The one-shot live-eval workflow was removed after evidence capture and is absent from `main`.

## Codex status

Deterministic adapter/account/controller evidence is green: exact protocol pin, account isolation, quota semantics, logout/rotation, browser/device-code flow and no automatic paid fallback. No authenticated live subscription App Server session is claimed in `v0.1.0`.

## Next block — B13

B13 is now allowed to start from accepted B12. It is a separate Builder/deployment acceptance block and must preserve the published `v0.1.0` evidence.

The first bounded slice should follow the canonical specification rather than expand scope ad hoc: establish the exact B13 baseline and implement the smallest repo/workspace boundary before any production deployment authority.

Operational procedure: `docs/RUNBOOK.md`. Acceptance truth: `docs/B12-ACCEPTANCE-MATRIX.md`. Evidence ledger: `docs/RELEASE-REPORT.md`.
