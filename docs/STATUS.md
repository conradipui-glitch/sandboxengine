# Статус движка

Последнее обновление: 2026-09-07.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B08-02 published; B08-03 functional accepted, canonical B08 BLOCKER=0** | B08-02 merge `a3eef28d106d89bdc4e05cf5c9fd7c1eb61e97e1`, main CI `34108753710`; B08-03 hardening head `339b01b99ea70d8e2b9db958384d95be66598f8b`, CI `34112797727` success → final Publication Gate |
| Контракты/Core | **B01–B03 published** | deterministic gameplay authority |
| Runtime storage/API | **B04 published** | idempotency/fencing/SQLite/guest HTTP |
| Authoring / Control | **B05 published** | draft → validation → frozen playtest → Player |
| AI foundation | **B06 published** | provider/intent/narrator/AgentBackend boundary; canonical audit BLOCKER=0 |
| Presentation/assets/Player | **B07 published** | contracts + immutable assets + executor + Runtime/browser integration; merge `1889145e1784e9186d0914207168448c111b8114`, main CI `34102992250` |
| Plugins | **B08-01/B08-02 published; B08-03 functional accepted** | real installed `dice-check`; deterministic generic execution; artifact-bound authored sidecar; canonical B08 audit BLOCKER=0 |
| Auth/publish | не начато | B09 immediately after verified B08 publication |
| Author AI helper | не начато | B10 |
| Florence migration | не начато | B11 |

## B08 publication foundation

### B08-01 — manifest / deterministic registry

PR #28 merged as `375233479ab787a6215be7a1d6aab52ec9c47a74`; exact `main` push CI `34105710910` succeeded.

Published behavior:

- data-only plugin manifest schema/API versioning;
- namespaced plugin IDs;
- deterministic dependency registry;
- explicit fail-closed release compatibility;
- no dynamic/remote plugin source loading.

### B08-02 — generic trusted backend execution

PR #29 merged as `a3eef28d106d89bdc4e05cf5c9fd7c1eb61e97e1`; exact `main` push CI `34108753710` succeeded.

Published behavior:

- trusted executable registrations separate from manifests;
- frozen resolver state/args + simulation clock + bounded deterministic RNG;
- bounded data-only action plans;
- canonical effects/time/scheduler remain Core-owned;
- scheduler children enter Core's dynamic queue;
- failed execution publishes no candidate state/advanced RNG;
- Core cannot import plugin package;
- plugin package has static no-Core/no-DB/no-network/no-process/dynamic-code/determinism guards.

## B08-03 — real `dice-check` extensibility proof

Branch: `b08-03-dice-check-proof-plugin`.  
PR: #30.  
Task: [B08-03](tasks/B08-03-dice-check-proof-plugin.md).  
Decision: [ADR 0028](decisions/0028-dice-check-proof-and-frozen-authored-sidecar.md).  
Audit: [B08-03 semantic audit](audits/2026-09-07-b08-03-semantic-audit.md).  
Canonical audit: [B08 canonical audit](audits/2026-09-07-b08-canonical-audit.md).  
Worklog: [2026-09-07 B08-03](worklog/2026-09-07-b08-03.md).

### Accepted behavior

- build-installed `dice-check@1.0.0` is real registry data;
- capability `dice-check.capability.skill-check`;
- action `dice-check.action.skill-check`;
- schema `dice-check.schema.skill-check@1.0.0`;
- schema-driven Studio form metadata + recipe;
- authored difficulty/modifier/duration and success/failure canonical-effect branches;
- player action args can select only an authored `definitionId`;
- resolver performs exactly one d20 host-RNG draw;
- same state/definition/args/seed gives the same plan/provenance/result/Core candidate;
- narrative projection is bounded text-only substitution;
- plugin requirements preflight returns explicit `MISSING_PLUGIN` when absent;
- `DiceCheckAuthoredSidecar` binds executable definitions to the exact frozen artifact hash before registration;
- no `dice-check` ID/import/arithmetic exists in Core;
- generated agent docs advertise the one installed plugin and its implemented metadata.

### Evidence

- first implementation `acdce4946193a67407723a49c9ca6cada7226d13` → CI `34109914329` exposed TypeScript defects only;
- type fix `d913d7b38676b00a1f209ef31e0be21c11a5a0d6` → CI `34110050259`: functional suites green, generated docs stale only;
- generated-doc sync `8c23a3358e5783ee2b4d998d6ae525d478b0f7d2` → CI `34112482535` success;
- post-green audit found authored-definition/frozen-artifact binding gap;
- artifact-binding hardening `339b01b99ea70d8e2b9db958384d95be66598f8b` → CI `34112797727` success;
- B08-03 unresolved semantic BLOCKER = **0**;
- canonical B08 unresolved BLOCKER = **0**.

## Honest scope boundary

B08 intentionally does **not** implement:

- untrusted third-party plugin sandbox/marketplace;
- dynamic remote plugin loading;
- custom `WorldState.extensions[pluginId]` reducers;
- public generic Runtime plugin action endpoint;
- complete Studio plugin editor/custom result widget;
- production auth/publish persistence/enforcement of plugin sidecars.

The last item is B09 scope. B08 supplies the immutable sidecar/preflight contracts required to wire it without changing Core or old v1 release/playtest contracts.

## B08-03 Publication Gate

Remaining:

1. final full CI on exact docs/current head;
2. update PR #30 with final evidence;
3. mark PR #30 ready;
4. pinned merge at exact expected head;
5. exact merge-SHA push-to-main CI;
6. only then call B08 published;
7. create B09 exactly from the verified B08 merge SHA.

Weighted implementation estimate at B08 functional completion: roughly **85–86%**. B08 is not counted as published until exact `main` CI on the B08-03 merge SHA succeeds.
