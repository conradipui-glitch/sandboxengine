# Changelog

Этот файл фиксирует release-facing изменения. Версия B12 пока **не тегирована**; раздел ниже остаётся Unreleased до финального exact-head CI, merge и проверки `main`.

## Unreleased — B12 release candidate work

### Added

- external post-deploy production smoke for the companion `sandbox` Worker;
- SQLite online backup/restore release drill with 12/12 Florence asset hash verification;
- durable release rollback drill proving future-session pointer rollback while existing sessions retain immutable pinned releases across restart;
- persistent Runtime+Control startup/shutdown drill with `/healthz`, SQLite creation and graceful SIGTERM exit;
- permanent dependency release audit in root `npm run verify`;
- provider HTTP 429 save-integrity regression;
- real Chromium 360×800 Studio onboarding/focus/keyboard release smoke;
- consolidated T01–T33/T36–T37 B12 acceptance matrix and operational runbook;
- bounded real OpenRouter provider evaluation with release telemetry.

### Changed

- build dependency `ajv` upgraded to `8.20.0`;
- transitive `fast-uri` refreshed to `3.1.7`;
- root `verify` now includes backup/restore, rollback, startup/shutdown and release-audit gates;
- persistent server startup logs report the actual bound ports, including ephemeral-port drills;
- README replaced the obsolete bootstrap description with the implemented runtime/authoring/release surface.

### Security / reliability

- current full and production npm dependency graphs report zero known vulnerabilities at the accepted B12 security gate;
- provider rate-limit failure completes as replayable no-turn and leaves authoritative save unchanged;
- release rollback preserves immutable release hashes and publication history;
- live provider evaluation on `deepseek/deepseek-v4-flash-0731` preserved the structural contract in 12/12 cases;
- temporary contents-write/browser/live-eval evidence workflows were removed after gathering bounded evidence and do not ship.

### Known limitations before B12 tag

- the bounded `deepseek/deepseek-v4-flash-0731` run scored 5/12 (41.7%) on the small semantic corpus despite 12/12 structural-contract safety; this evidence does not qualify it as the recommended intent model;
- provider token usage was incomplete across live cases, so aggregate token count is `null` rather than inferred;
- no authenticated live Codex subscription run is claimed;
- Florence Engine production rollout remains an explicit operational switch in the companion app;
- Cloudflare Durable Object backup/restore is outside the standalone SQLite backup claim;
- B13 Builder/code/GitHub/deployment orchestration is not shipped.

## B11 and earlier

B01–B11 established contracts/Core, deterministic scheduling and storage, Studio/Player, AI boundaries, presentation/assets, plugins, authentication/publication/portability, author assistant/Codex boundaries, and migration of Florence plus Transfer Desk. Exact publication SHAs and CI evidence are maintained in `docs/RELEASE-REPORT.md` and `docs/STATUS.md` rather than duplicated here.
