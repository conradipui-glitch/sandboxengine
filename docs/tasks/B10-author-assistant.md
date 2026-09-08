# B10 — interactive author assistant, Skills/MCP broker and Codex adapter

## Goal

Build the first product-grade authoring assistant on top of published B09 without widening gameplay authority: an author can describe a campaign change in normal language, receive or auto-assemble a typed `AuthoringProposal`, validate it against an exact draft snapshot, see a deterministic diff/preview, atomically apply it as a new draft revision, pause/resume/cancel long authoring work, and export a precise external-agent task package when the requested mechanic is not representable by installed capabilities.

Base: published B09 merge `0a5d643844684b41d10d2267ae23c7a654ceecf9`, exact `main` push CI `34166564821` — success.

Specification sources: §9.9 AgentBackend, §13 Skill/agent-kit/task package, §14 Author AI assistant, B10 card in §19, acceptance T32–33/T36–37.

## Main invariant

**The author assistant may read bounded authoring context and propose or apply only typed Control draft changes within an explicit project/quest/revision capability grant. It never becomes gameplay authority, never publishes, never obtains shell/filesystem/repository/deployment authority in B10, never turns documentation/MCP/Skill text into permissions, never silently applies against a stale draft, and never falls back from subscription/Codex access to paid API use without an explicit configured connection and budget.**

## Architecture

Keep the published authority split:

- `@living-history/control` owns canonical `AuthoringProposal`, draft snapshot/diff/validation/apply semantics and durable authoring job records when they mutate authoring state;
- `@living-history/ai` owns `AgentBackend` lifecycle, backend identity/capability description, usage/quota and bounded authoring-model adapters; it does not write drafts directly;
- `apps/server` owns authenticated HTTP policy, project-role checks, CSRF/Origin/CORS, capability grants, orchestration and backend composition;
- `apps/studio` renders conversation/job/proposal evidence and calls server APIs; browser state is not authorization or revision authority;
- Core/Runtime remain unchanged by assistant orchestration; only already-validated Control draft revisions can later enter the existing playtest/release path.

Execute B10 in three independently green subparts on one branch/PR:

1. **B10.a** — typed `AuthoringProposal`, server validate-on-copy/diff/atomic apply, persistent Author chat + `AgentJob`/checkpoint/pause/resume/cancel and fake author backend;
2. **B10.b** — bounded context selection, generated agent-kit/version handshake, Skills/MCP broker and exact external task package;
3. **B10.c** — Codex App Server adapter with account isolation, supported login/logout/rate-limit handling and author-only tool policy; API-mode remains independent.

Do not start B10.b/c by faking B10.a server contracts. Do not add B13 repo/build/deploy tools in B10.

## B10.a — proposal and durable author job

### 1. `AuthoringProposal` contract

A proposal must be inert typed authoring data, not source-code/filesystem patches. At minimum it contains:

- stable proposal ID;
- projectId / questId;
- exact `baseRevision` and base draft content hash;
- explanation/summary for the author;
- bounded ordered batch of canonical draft changes using already-supported authoring operations;
- origin metadata identifying assistant/backend/job without storing credentials;
- optional missing-capability records instead of invented blocks;
- deterministic created/updated timestamp/ordinal chosen by server persistence, not trusted as authority from the model.

Rules:

- unknown operation/kind/field fails closed;
- duplicate block IDs or ambiguous references fail closed through canonical Control semantics;
- proposal cannot contain publish/release/role/credential/runtime/player operations;
- model-provided IDs are bounded and cannot escape project/quest scope;
- proposal payload size and change count are bounded.

### 2. Validate on an isolated draft copy

Server/Control must preview a proposal against the exact stored `baseRevision` without mutating the real draft:

- load exact immutable draft snapshot;
- apply the batch using the same canonical draft mutation semantics used by real edits;
- run canonical validation/compile appropriate to current authoring data;
- compute deterministic before/after diff and resulting draft hash;
- surface concrete validation/reference errors;
- leave current draft/history/releases/playtests unchanged.

A preview from a stale base is still inspectable but must be marked stale relative to current revision; it is never an apply authorization.

### 3. Atomic apply by exact revision

Applying a previously previewed proposal requires:

- editor/owner role; tester cannot apply;
- CSRF + existing mutation policy at HTTP boundary;
- exact current `baseRevision`/hash match;
- server-derived request hash + idempotency key;
- revalidation of the proposal immediately before commit;
- one atomic new draft revision for the whole batch;
- immutable provenance containing proposal/job/backend safe identity but no credential/thread secret;
- retry of identical request returns same applied revision; key reuse with changed input conflicts;
- stale base returns conflict and does not partially apply or auto-merge.

No proposal operation publishes or builds a release automatically.

### 4. Missing capability behavior

If the user asks for mechanics not representable by installed blocks/plugins:

- proposal records an explicit missing capability;
- no fake `core.*` block is invented;
- B10.b can turn the missing capability into the §13.4 task package;
- current draft may contain only explicitly supported placeholder metadata if the canonical schema already supports it; otherwise no mutation occurs.

### 5. `AgentJob` durable lifecycle

Introduce authoring job identity separate from Runtime turns. Minimum states:

`queued`, `running`, `waiting_user`, `paused_budget`, `validating`, `succeeded`, `failed`, `cancelled`.

Persist safe job data needed to survive reload/process reopen:

- job ID, project/quest, owner user identity;
- mode (`author` for B10.a; developer mode remains export-only until later);
- exact starting draft snapshot identity;
- backend safe identity and opaque backend session/thread reference only when safe to persist;
- explicit capability grant (allowed authoring operations, project/quest, expiry/budget);
- tool/operation journal using stable operation IDs;
- checkpoint/progress events based on facts, not invented percentages;
- provider usage/budget counters when available;
- proposal IDs/artifacts already produced/applied;
- cancellation/pause state.

Never persist API keys, session cookies, CSRF tokens, Runtime guest credentials or provider auth tokens in the job record.

### 6. Resume, retry and budget

T32 requires interruption safety:

- mutating tool calls have stable operation IDs and base revisions;
- completed operations are replayed from durable result, not executed again after transport loss;
- duplicate model output cannot re-apply an already applied proposal;
- default author segment budget follows §14.5 product defaults (up to 12 tool calls / 120 seconds active work unless explicitly configured otherwise);
- exhaustion moves job to `paused_budget` with checkpoint;
- explicit resume continues from checkpoint and existing artifacts;
- cancel stops new calls, preserves already committed revisions and marks pending work cancelled;
- no hidden switch to another paid connection/backend on quota/auth failure.

### 7. Fake author backend first

Use deterministic fake/scripted author backend for acceptance before live inference:

- scripted valid proposal;
- malformed proposal;
- missing-capability response;
- backend timeout/rate-limit/auth failure;
- duplicate/replayed output;
- pause/resume/cancel path.

The fake backend proves orchestration/state semantics only; it does not prove real Russian-language understanding.

### 8. Persistent Studio assistant shell

Only after B10.a server/job contracts are real:

- assistant panel available from authoring screens and collapsible without losing current conversation/job;
- header shows actual mode/backend/model/known quota state/current job/stop action;
- messages and artifact cards are reconstructed from persisted server events;
- proposal card shows exact base revision, deterministic diff, validation state and explicit Apply when allowed;
- auto-build mode may apply validated changes only inside the explicit job grant and still records each applied revision;
- stale proposal visibly blocks apply until re-preview/rebase by explicit server flow;
- progress uses factual events such as “read 4 blocks”, “proposal validated”, “draft r7 saved”; no hidden chain-of-thought or invented completion percentage.

## B10.b — selective context, Skills/MCP and agent kit

### 9. Bounded context selector

Assistant starts from selected blocks + nearest typed dependencies + capability catalog + project style. It may request additional allowed blocks through broker reads. Do not send the entire project by default.

Context evidence records which block IDs/revisions were actually read, without copying secrets into universal prompts.

### 10. Agent kit and version handshake

Finish downloadable/generated agent kit from §13:

- short Skill policy;
- exact OpenAPI/capability/schema indexes;
- compatibility file with engine/schema/API/registry/docs hashes;
- checked recipes for quest authoring, scene presentation, plugin, UI/provider extension and migration validation;
- server endpoint to obtain only the installed build’s kit when authorized;
- version/registry/docs handshake before agent writes.

Stale/mismatched docs block apply until refreshed; generated docs never advertise unavailable operations.

### 11. Skills/MCP broker

Broker enforces capabilities independent of Skill/MCP text:

- allow only declared read/search authoring/docs operations and proposal/apply operations granted to the job;
- deny shell, filesystem, repository mutation, code execution, deployment and secret reads in B10;
- MCP offline produces a typed unavailable result and documented fallback when one exists;
- a Skill update mid-job does not silently change active version or permissions;
- third-party instructions are task material, never permission elevation.

This is the main T33/T36 boundary.

### 12. External task package

For missing capability, export exact inert task package with:

- human goal;
- installed engine/version/registry/docs hashes;
- exact capability ID;
- allowed paths;
- input/output and relevant block/UI schemas;
- invariants/forbidden actions;
- executable verification commands;
- test examples;
- expected change list;
- migration notes if needed.

Package excludes secrets and unrelated project content. An external agent should be able to prepare a plugin-like change without reading chat history.

## B10.c — Codex App Server adapter

### 13. Adapter boundary

Implement Codex as an `AgentBackend`, not as `ModelProvider` and not from browser WebSocket/auth token forwarding.

Initial supported transport is local App Server process/stdio with protocol schema bound to installed version. Adapter exposes only B10 authoring broker tools; no B13 repo/deploy authority.

### 14. Account/login isolation

Cover T37 explicitly:

- supported `account/login/start` (`chatgpt` / device-code when installed version supports it);
- login result, identity, logout;
- `account/rateLimits/read` + update notifications when supported;
- two users/accounts remain isolated; cache keys include account/credential revision;
- logout/credential rotation invalidates old quota/session state;
- expired/refused auth is surfaced honestly;
- no experimental borrowed-token flow;
- no silent fallback to paid API inference.

If a live Codex account is unavailable in CI/environment, keep deterministic protocol/adapter tests green and record the live-path limitation rather than claiming acceptance evidence that was not run.

## Registry/generated docs

Only implemented B10 HTTP operations are marked available. Regenerate deterministic agent/OpenAPI docs in the same change set.

Do not advertise B13 Builder/repository/deployment endpoints.

## Required regressions

### B10.a

1. proposal payload is bounded and rejects unknown/non-authoring operations;
2. preview uses exact immutable base snapshot and does not mutate current draft/history/releases/playtests;
3. deterministic preview diff/hash for same snapshot/proposal;
4. invalid canonical references/schema fail preview without mutation;
5. apply creates exactly one new revision for the whole batch;
6. apply provenance contains safe backend/job identity and no credential/thread secret;
7. stale base revision/hash blocks apply without partial mutation;
8. identical idempotent retry returns same revision; changed request on same key conflicts;
9. tester cannot apply; owner/editor can within server role policy;
10. proposal cannot publish/build release or change access roles;
11. missing mechanic produces `missing_capability`, not a fake working block;
12. job survives reload/SQLite reopen with state/checkpoint/artifacts;
13. completed mutating operation is not duplicated after response loss/retry;
14. duplicate backend output cannot duplicate already applied blocks;
15. tool/time budget pauses job and explicit resume continues from checkpoint;
16. cancel prevents new calls and preserves already committed revisions;
17. auth/quota/backend failure never silently switches to another paid connection;
18. Studio renders persisted conversation/job/proposal state and stale proposal blocks Apply.

### B10.b

19. selected-context bundle omits unrelated project blocks by default;
20. version/registry/docs mismatch blocks writes until refreshed;
21. generated agent kit matches current registry/docs hashes;
22. T33 secret/shell/deploy attempts are denied by broker even when Skill/MCP text asks for them;
23. MCP offline has typed failure/fallback without widening permissions;
24. new Skill/version mid-job does not silently change active permissions/context;
25. task package is sufficient for plugin-style extension and excludes secrets/unrelated project data.

### B10.c

26. Codex protocol adapter is pinned/validated against installed protocol schema;
27. supported login success/refusal/expiry/logout states are distinct;
28. two accounts cannot see each other’s identity/quota/session state;
29. quota null/zero/reset metadata is preserved honestly;
30. logout/credential rotation invalidates cached identity/quota/session handles;
31. unavailable subscription auth does not trigger paid API fallback;
32. only authoring broker tools are exposed; shell/repository/deploy remain denied.

### Closure

33. T32–33/T36–37 mapped to deterministic evidence;
34. one bounded live authoring run only when a configured real backend/limit is available;
35. root `npm run verify`, recipe checks and deterministic `docs:check` green;
36. semantic audit unresolved BLOCKER = 0 before Publication Gate.

## Functional acceptance

B10 is accepted when:

1. an author message can produce a typed proposal over bounded context;
2. proposal preview/diff is server-authoritative and non-mutating;
3. valid proposal applies atomically to an exact current draft revision, stale proposals never overwrite;
4. durable `AgentJob` supports interruption, idempotent replay, pause/resume/cancel and factual progress;
5. unknown mechanics become an exact task package rather than invented functionality;
6. agent-kit/version handshake and Skills/MCP broker preserve least privilege and stale-doc safety;
7. Codex adapter, where available, preserves account isolation/auth/quota semantics with no paid fallback surprise;
8. the real Studio path “describe campaign → linked blocks → correction by reply → open playtest” is proven without manual JSON using fake backend and, when configured, one bounded live run;
9. T32–33/T36–37 have explicit evidence and canonical audit BLOCKER=0;
10. final exact-head CI, pinned merge and exact main push CI complete before calling B10 published.

## Not now

- shell access in the game/server process;
- arbitrary filesystem or repository mutation;
- GitHub branch/PR writes by the assistant;
- build/test execution initiated by author chat against repository checkout;
- deployment/rollback runner;
- automatic plugin installation from generated code;
- public Skill marketplace or unpinned automatic Skill updates;
- live collaborative author editing/CRDT;
- automatic conflict merge;
- Florence migration (B11);
- production release/backup hardening (B12);
- B13 Builder/GitHub/deployment profile.

## Current bounded checkpoint

**B10.a is implemented and B10.b is green through the bounded-context + agent-kit handshake foundation.** B10.a has typed proposal preview/apply, durable Memory/SQLite jobs/checkpoints/conversation/artifacts, server discovery/segment/cancel contracts, persistent Studio chat, job-scoped server-artifact Apply, stale fail-closed preview, budget pause/resume, and cancellation that aborts the active backend signal and discards late success before proposal persistence.

**B10.b.9 is closed:** model context is no longer whole-draft by default; the server builds a bounded entry-seeded bundle, includes only selected blocks plus nearest outgoing typed dependencies, carries the installed capability catalog, enforces hard selection bounds, and persists `context.selected` evidence that survives SQLite reopen and is rendered in Studio.

**B10.b.10 is closed:** generated compatibility includes deterministic `apiHash` and aggregate `docsHash`; authenticated `GET /control/v1/agent-kit` returns the exact installed generated kit; direct proposal Apply and job-scoped Apply require exact installed engine/registry/docs identity; Studio refreshes the installed kit before Apply; and five checked generated recipes (quest authoring, scene presentation, plugin extension, UI/provider extension, migration validation) participate in `docsHash`. Recipe generation fails closed on missing repository paths or verification commands outside the explicit safe allowlist/root scripts. `control.agent-kit` is available while broad `control.capabilities` remains planned.

**B10.b.11 Skills/MCP broker is implemented through the compatible backend tool-loop gate:** server-owned broker policy/default-deny is independent of Skill/MCP text; the active installed docs/Skill hash, broker policy hash and exact job-granted tool set are pinned durably in the job checkpoint journal; current draft read/proposal preview/apply paths pass broker authorization; shell/filesystem/repository/code/deployment/secret tool IDs are not in the trusted catalog. `docs.reference.read` is a distinct job-granted operation only when a verified reference MCP client is composed. Each call is reserved before transport, consumes segment tool/time budget, records exact connection/version/query identity plus bounded result/failure, and replays without a second MCP call after response loss or SQLite reopen. The existing `AgentBackend` remains `toolPolicy: none`: a compatible backend may only emit one strict in-band `docs.reference.read` request, the host executes it through the brokered bridge, returns bounded untrusted `tool_result` material in the same session, and a second tool request fails closed. Parent cancel aborts MCP, deadline is shared, budget pause/resume replays the durable read, and offline/timeout never trigger implicit permission or paid fallback.

**B10.b.12 is closed:** exact persisted missing capabilities can be exported through an editor-owned read-only HTTP route as deterministic inert standalone task packages. The package carries the current installed compatibility identity, exact capability ID, static plugin change allowlist, bounded embedded schemas, checked plugin recipe, invariants/forbidden actions, verification commands, tests, expected changes and migration notes. The builder receives no ControlStore/draft/conversation, credential-shaped goals fail closed, already-installed capabilities are stale, wrong selectors are hidden, and repeated export remains byte-equivalent after unrelated draft edits. B10.b is now complete.

**B10.c.13 is closed:** Codex is a separate no-tools `AgentBackend` over a narrow local-stdio transport contract with exact app-server/protocol/schema pinning. Constructor/initialize drift, browser token forwarding, unsafe native shell/filesystem/repository/browser/app/plugin capability and observed native-tool activity all fail closed. The adapter exposes no account or arbitrary app-server method surface, and auth/rate-limit errors remain typed without another provider fallback.

Next bounded slice: **B10.c.14 account/login/quota isolation** — support only current non-experimental ChatGPT browser/device-code login through a separately scoped account transport, preserve current-account/rate-limit truth, invalidate sessions/cache on logout or credential rotation, and prove no API-key, experimental borrowed-token or Luna Reserve fallback. After that, run the B10 semantic closure audit and exact-head root verify.
