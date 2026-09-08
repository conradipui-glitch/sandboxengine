# B10 semantic closure audit

Status: **CLOSURE CANDIDATE** until the exact-head root verify and merge/main push evidence are recorded.

## Acceptance evidence map

### T32 — interruption-safe durable author work

Evidence lives in the B10.a durable job/operation/conversation regressions under `packages/control/test/`, `apps/server/test/author-job-http.test.mjs`, and Studio author-assistant tests. They prove exact-revision/idempotent apply, durable operation replay, budget pause/resume, cancellation, persisted proposal artifacts/conversation and stale fail-closed Apply. No model/backend output writes drafts directly.

### T33 — secret/tool authority boundary

`packages/control/src/author-tool-broker.ts` is default-deny and its trusted catalog contains only bounded authoring/docs operations. B10.b reference MCP and compatible backend loop regressions prove shell/filesystem/repository/code/deployment/secret attempts are not granted by Skill/MCP text; MCP offline/timeout remains typed and never becomes another authority path. `packages/ai/src/codex-app-server-backend.ts` separately fail-closes unsafe native Codex capabilities and observed native tool activity.

### T36 — Skills/MCP/version safety

Generated agent-kit compatibility binds engine/schema/API/registry/docs hashes. Job broker pins persist exact docs/policy/tool identity; mid-job mismatch fails closed. Reference reads are reserved before transport, bounded, journaled and replayed without duplicate transport calls. External missing-capability packages are deterministic inert exports with explicit allowed paths/invariants/tests and no project secrets/unrelated draft content.

### T37 — Codex account isolation/auth/quota

`packages/ai/test/codex-app-server-backend.test.mjs` proves exact protocol/safe-transport pinning and no-tools author sessions. `packages/ai/test/codex-app-server-account.test.mjs` proves browser/device-code subscription login, distinct refusal/expiry/no-auth/API-key/unsupported states, exact owner+connection isolation, cache identity including account+credential revision, honest false/zero/null/reset quota values, sparse notification isolation, `supportsLunaReserve: false`, no experimental borrowed-token/API-key fallback, and logout/credential-rotation invalidation of already-open author session handles.

## Functional author cycle

`apps/studio/test/b10-full-author-assistant-cycle.test.mjs` is the closure regression for the user-visible fake-backend path: natural-language author request -> linked resource/action proposal -> server preview -> job-scoped Apply -> correction by second author message -> second Apply -> validation -> frozen playtest. It uses `ControlApiClient` rather than hand-submitting an `AuthoringProposal`.

## Targeted closure evidence

- B10.c.13 Codex adapter boundary: production head `72972e48095ff6a0920a28127fad7425b610dc8c`, targeted run `34207098014` — typecheck/AI/boundary/docs/diff/self-clean GREEN.
- B10.c.14 account/login/quota isolation: production head `b021fc33bd949e1bf6ffffe144e8efa78393d8fc`, targeted run `34208186688` — typecheck/AI/server/boundary/docs/diff/self-clean GREEN.
- B10 closure acceptance: production head `b78a0bf68748c27240731689a2d50c60e92a0ddc`, targeted run `34208615382` — typecheck/Studio/server/AI/boundary/docs/diff/self-clean GREEN, including the full fake-backend author-to-playtest regression.

## Live Codex limitation

No authenticated real Codex App Server account/process is configured in repository CI. The task explicitly allows deterministic adapter/protocol evidence in that environment. Therefore no live subscription run is claimed. When a real local App Server/account is configured, one bounded authoring run is still useful operational evidence but is not a blocker for deterministic B10 acceptance.

## Semantic audit

- Gameplay authority remains Core/Runtime; B10 changes only authoring/control orchestration.
- Publication remains explicit owner action; no assistant/Codex path publishes or rolls back.
- Browser state remains presentation/transport only.
- No B10 broker/backend/account surface grants shell, arbitrary filesystem, repository mutation, code execution or deployment.
- No automatic merge, plugin installation, migration or paid-provider fallback was introduced.
- External task package is inert and cannot mutate the repository itself.
- Codex account methods are outside `AgentBackend`; author turns cannot call login/logout/quota methods.

**Unresolved BLOCKER: 0.**

## Publication gate

Before B10 is called published: exact-head root `npm run verify` must be green, PR must merge from the pinned B09 base lineage, and exact `main` push CI must be green.
