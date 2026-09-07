# Статус движка

Последнее обновление: 2026-09-07.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B08-01 published; B08-02 functional accepted, BLOCKER=0** | B08-01 merge `375233479ab787a6215be7a1d6aab52ec9c47a74`, main CI `34105710910`; B08-02 hardening head `a8cec6c6fc7e1721d5d9b965cb9e57c88040163a`, CI `34108349316` success → Publication Gate |
| Контракты/Core | **B01–B03 published** | deterministic gameplay authority |
| Runtime storage/API | **B04 published** | idempotency/fencing/SQLite/guest HTTP |
| Authoring / Control | **B05 published** | draft → validation → frozen playtest → Player |
| AI foundation | **B06 published** | provider/intent/narrator/AgentBackend boundary; canonical audit BLOCKER=0 |
| Presentation/assets/Player | **B07 published** | contracts + immutable assets + executor + Runtime/browser integration; merge `1889145e1784e9186d0914207168448c111b8114`, main CI `34102992250` |
| Plugins | **B08-01 published; B08-02 functional accepted** | manifest/registry published; trusted backend resolver/scheduler host accepted; B08-02 CI `34108349316`, semantic BLOCKER=0 |
| Auth/publish | не начато | B09 after B08 |
| Author AI helper | не начато | B10 |
| Florence migration | не начато | B11 |

## B08-01 publication

PR #28 merged as `375233479ab787a6215be7a1d6aab52ec9c47a74`; exact `main` push CI `34105710910` succeeded. The published build has plugin manifest/API compatibility infrastructure but intentionally advertises zero installed plugins.

## B08-02 — trusted backend plugin execution

Branch: `b08-02-backend-plugin-execution-contracts`.  
PR: #29.  
Task: [B08-02](tasks/B08-02-backend-plugin-execution-contracts.md).  
Decision: [ADR 0027](decisions/0027-trusted-backend-plugin-execution.md).  
Audit: [B08-02 semantic audit](audits/2026-09-07-b08-02-semantic-audit.md).  
Worklog: [2026-09-07 B08-02](worklog/2026-09-07-b08-02.md).

### Accepted behavior

- executable registrations are trusted build-time code separate from data manifests;
- registration IDs must match installed manifest declarations;
- resolver sees detached frozen state/args, simulation time and bounded host RNG only;
- resolver returns exact bounded data-only `PluginActionPlan`;
- candidate state/state patches/executable widening fail closed;
- canonical effects use existing Core `tryApplyEffectBatch`;
- duration uses existing Core time planning/application;
- plugin scheduler children run through Core `processTimeAdvancePlan` dynamic queue;
- Core owns generated child duplicate/past/order/event/step limits and final transition;
- failed plugin/Core transitions publish no candidate state or advanced RNG state;
- custom plugin effects remain unsupported because `WorldState` v1 has no plugin extension namespace;
- Core cannot import plugin package; plugin package is statically guarded from Core/DB/network/process/dynamic-code and obvious wall-clock/entropy shortcuts;
- no plugin-specific conditional was added to Core.

### Evidence

- early generic host `234ac18ffd160de6d147579df774c230775ab549` → CI `34106576923` success;
- corrected/hardened facade `7154dfb5512b186728e2c8d6a25fea3ad9252f38` → CI `34107248938` success;
- scheduler-through-Core hardening `1b10aa7aaf25ae877f81575c192482a806b5a135` → CI `34108213347` success;
- architecture/determinism hardening `a8cec6c6fc7e1721d5d9b965cb9e57c88040163a` → CI `34108349316` success;
- unresolved semantic `BLOCKER = 0`.

## Honest scope boundary

B08-02 does **not** add:

- the concrete `dice-check` plugin;
- custom `WorldState` extension reducers;
- public Runtime plugin action endpoint;
- Studio plugin form/recipe UI;
- UI component plugin renderer;
- third-party sandbox/marketplace security;
- Runtime/publish enforcement of release plugin requirements.

## B08-02 Publication Gate

Remaining:

1. final full CI on exact docs/current head;
2. update PR #29 with final evidence;
3. mark PR #29 ready;
4. pinned merge at exact expected head;
5. exact merge-SHA push-to-main CI;
6. only then call B08-02 published;
7. create B08-03 exactly from verified B08-02 merge SHA.

## Next B08 slice

**B08-03 — `dice-check` proof plugin**: install one real plugin through the published manifest/registry + B08-02 execution host, add authored schema/recipe proof and compatibility failure when the plugin is absent, while keeping Core free of plugin-specific branching.

Weighted implementation estimate at B08-02 functional acceptance: roughly **82–83%**. B08-02 is not counted as published until its exact `main` CI passes.
