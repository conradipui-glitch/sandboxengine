# Статус движка

Последнее обновление: 2026-09-08.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B10 published; B11 implementation complete, publication gate active** | B10 merge `4e5fea2888d14440c60ad48abffbefe42abfe637`; B11 PR #35 contains real quests, authored Runtime, semantic acceptance and verified source assets |
| Контракты/Core | **B01–B03 published; B11 generic authored cases added without quest branches** | Core conditions/effects remain generic; source test rejects Florence/Transfer Desk identities in `packages/core` |
| Runtime storage/API | **B04 published; B11 authored Runtime integrated** | published release/session pinning, explicit authored options, free-text intent boundary, blocked/no-turn and idempotent replay proved |
| Authoring / Control | **B05 + B09 published** | durable history/compare/restore/reference safety + portability + immutable release/publication authority |
| AI foundation | **B06 + B10 published; B11 intent boundary reused** | free text receives current authored catalog; AI interprets, Runtime/Core validates and mutates |
| Presentation/assets/Player | **B07 published; B11 compatibility projection complete** | Engine exposes safe `situation`; `sandbox` BFF projects Engine state to existing `GameState` without client-side gameplay arithmetic |
| Plugins | **B08 published** | trusted manifest/registry/execution + artifact-bound plugin evidence |
| Auth/publish/Studio | **B09 published** | account/login/quota isolation, frozen playtest evidence, version/restore/portability and owner publication flow |
| Author AI helper | **B10 published** | PR #34; semantic audit unresolved BLOCKER 0; full author request → Apply → correction → validation → frozen playtest regression |
| Florence migration | **B11 implementation complete** | exact source SHA `092bcef0be5943e32bf02f08f9e9d4cde393fa95`; canonical + compromise + authorship + withdrawal semantics; 6 WebP + 6 MP3 byte-verified and committed |
| Cross-repo rollout | **B11 implementation complete** | `sandbox` PR #10: new-session-only Engine routing, durable route pinning, rollback, prepared/freeform split, client-compatible facade; legacy sessions remain untouched |
| Release hardening | **next after B11 publication** | B12 starts only after exact-head B11 CI and publication/merge gate |

## Published B10 checkpoint

B10 is closed and published.

- PR: #34
- verified PR head: `f03e283d5e027cb93dea7d3f149685b058724ad0`
- merge SHA: `4e5fea2888d14440c60ad48abffbefe42abfe637`
- exact `main` CI: #650 / run `34209005817` — `success`
- canonical semantic audit: unresolved BLOCKER **0**

## B11 source and migration boundary

B11 starts from the exact published B10 merge and migrates Florence from:

- source repo `conradipui-glitch/sandbox`;
- source merge PR #9;
- exact source SHA `092bcef0be5943e32bf02f08f9e9d4cde393fa95`;
- exact source production workflow #47 / run `34012448412`, successful through install, tests, build and deploy.

The migration preserves causal semantics rather than copying legacy implementation branches. The six source decisions are authored narrative beats; elapsed time remains a generic Runtime clock concern. There is no `FlorenceMemory` or `scenarioId === "florence-workshop"` branch in Core.

## B11 implemented acceptance

### Real quests

- `examples/florence` is a full six-beat quest using generic resources, conditions, effects and state-dependent authored cases.
- `examples/transfer-desk` is a genuinely different three-beat social/item-transfer quest, not a Florence rename.

### Florence semantic comparison

Accepted routes include:

- canonical `draft → ledger → counter → pigment → public → deliver` → `Незавершённое принято`;
- paid compromise `healer → team → advance → testimony → share-ledger → deliver` → `Чужое имя над вашей работой`;
- authorship/refusal `close → refuse → protect → testimony → rest → sign` → `Имя без заказчика`;
- conditional counter remains conditional without sufficient prior support and becomes executed through generic state conditions when support exists;
- withdrawal does not invent a refund when no advance was received;
- blocked actions do not advance revision/clock or partially apply effects;
- retries remain idempotent at the Runtime/storage boundary.

### Engine ↔ sandbox integration

The companion `conradipui-glitch/sandbox` PR #10 provides the rollout boundary:

- rollout decision occurs only when a new Florence session is created;
- the chosen Engine route is stored in `RuntimeRouteSession` and stays pinned;
- switching rollout to `off` stops future assignment but does not migrate in-progress Engine sessions;
- ids without Engine bindings stay on legacy `HistorySession` unchanged;
- prepared client choices are forwarded as explicit `authored.option` actions;
- free text stays on the intent-interpreter boundary;
- Engine `PlayerView + situation` is projected server-side into the existing client-compatible `GameState`;
- the browser displays authored options and never computes authoritative gameplay consequences.

### Binary source assets

Florence source assets are now real repository content rather than placeholders:

- 6 WebP visuals copied from pinned source paths with exact source Git blob verification;
- 6 MP3 tracks assembled from ordered pinned `audio-parts`, with every source part Git blob verified before concatenation;
- `examples/florence/asset-migration-manifest.json` records byte counts, SHA-256 and resulting Git blob identities;
- root tests re-read all 12 committed binaries and verify SHA-256 against the migration manifest;
- `examples/florence/source-assets.json` records `binaryCopyStatus: verified-in-repository`.

## Publication gate

B11 implementation work is complete. The only remaining B11 step is publication hygiene:

1. require a full root `npm run verify` success on the exact final PR #35 head containing code, docs and binary assets;
2. record the exact successful run in PR #35;
3. ensure `sandbox` PR #10 remains green on its exact client/BFF head;
4. merge/publish in dependency-safe order;
5. begin B12 only after those merges are published.
