# Статус движка

Последнее обновление: 2026-09-08.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B10 published; B11 active** | B10 PR #34 merged as `4e5fea2888d14440c60ad48abffbefe42abfe637`; exact main CI #650 / run `34209005817` success |
| Контракты/Core | **B01–B03 published** | deterministic gameplay authority; B11 must add no Florence-specific branch to Core |
| Runtime storage/API | **B04 + publication/session pinning published** | immutable release identity and server-authoritative pinned sessions already available for B11 rollout |
| Authoring / Control | **B05 + B09 published** | durable history/compare/restore/reference safety + portability + immutable release/publication authority |
| AI foundation | **B06 + B10 author-assistant boundary published** | provider/intent/narrator boundary plus author request/apply/correction loop; Codex protocol evidence is deterministic, not a claimed authenticated CI subscription run |
| Presentation/assets/Player | **B07 published** | immutable assets + presentation executor + Runtime/browser integration |
| Plugins | **B08 published** | trusted manifest/registry/execution + artifact-bound plugin evidence |
| Auth/publish/Studio | **B09 published** | account/login/quota isolation, frozen playtest evidence, version/restore/portability and owner publication flow |
| Author AI helper | **B10 published** | PR #34; semantic audit unresolved BLOCKER 0; full regression author request → linked blocks → Apply → correction → Apply → validation → frozen playtest |
| Florence migration | **B11 active; B11.0 GREEN** | `docs/BASELINE.md` confirmed; `docs/tasks/B11-01-source-migration-map.md`; next B11.1 = real quest packages |
| Release hardening | не начато | B12 after accepted B11 real-quest integration |

## Published B10 checkpoint

B10 is closed and published.

- PR: #34
- verified PR head: `f03e283d5e027cb93dea7d3f149685b058724ad0`
- merge SHA: `4e5fea2888d14440c60ad48abffbefe42abfe637`
- exact `main` CI: #650 / run `34209005817` — `success`
- canonical semantic audit: unresolved BLOCKER **0**

B10 acceptance includes the Codex adapter boundary, account/login/quota isolation and the single regression path:

`author request → linked blocks → Apply → correction → Apply → validation → frozen playtest`.

A real authenticated Codex subscription/App Server run is **not** claimed because CI has no configured authenticated local App Server. B10 evidence for that boundary is deterministic protocol evidence.

## B11.0 — source confirmation gate

B11 starts from the exact published B10 merge `4e5fea2888d14440c60ad48abffbefe42abfe637` on branch `b11-real-quests-integration`.

B00 is now confirmed for B11 entry:

- source repo: `conradipui-glitch/sandbox`;
- Florence source merge: PR #9;
- exact source SHA: `092bcef0be5943e32bf02f08f9e9d4cde393fa95`;
- source current main checked at `f9b0cd0d607da48d89827f0a1a882b74e9b78e50` and differs after the baseline only by README/docs;
- exact source production workflow #47 / run `34012448412` succeeded through `npm ci`, tests, build and deploy;
- runtime routes, Durable Object save shape, idempotency and legacy-session boundary are mapped;
- legacy Florence tests prove all 729 prepared six-decision routes terminate with six trace entries and also cover conditional/blocked behavior, save/restore and legacy-save incompatibility;
- technical migration is explicitly separated from design changes;
- standalone Engine remains separate; `sandbox` gets only the later adapter/BFF rollout surface;
- only newly created Florence sessions may be routed to the Engine; old sessions remain on their pinned legacy runtime and are never silently converted.

Canonical evidence:

- `docs/BASELINE.md`
- `docs/tasks/B11-01-source-migration-map.md`

## B11 next slice

**B11.1 — real quest packages**

Create and validate:

- `examples/florence`
- `examples/transfer-desk`

Constraints:

- six Florence source decisions are narrative beats, not a generic turn/clock rule;
- Florence state must use generic authored/runtime state rather than a `FlorenceMemory` Core type;
- no Florence-specific identifiers/branches in `packages/core`;
- the real Transfer Desk example must differ in goal, items/resources and social causality rather than being Florence with renamed actors;
- old/new semantic comparison and new-session-only `sandbox` routing remain later B11 slices after the real quest packages exist.
