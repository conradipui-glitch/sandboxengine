# Статус движка

Последнее обновление: 2026-09-07.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B07 published; B08-01 functional accepted, BLOCKER=0** | canonical B07 merge `1889145e1784e9186d0914207168448c111b8114`, main CI `34102992250`; B08-01 hardening/docs head `adee3d4b…`, CI `34105282304` success → Publication Gate |
| Контракты/Core | **B01–B03 published** | deterministic gameplay authority |
| Runtime storage/API | **B04 published** | idempotency/fencing/SQLite/guest HTTP |
| Authoring / Control | **B05 published** | draft → validation → frozen playtest → Player |
| AI foundation | **B06 published** | provider/intent/narrator/AgentBackend boundary; canonical audit BLOCKER=0 |
| Presentation/assets/Player | **B07 published** | contracts + immutable assets + executor + Runtime/browser integration; merge `1889145e…`, main CI `34102992250` |
| Plugins | **B08-01 functional accepted** | trusted manifest/schema, deterministic dependency registry, release compatibility, generated plugin metadata; CI `34105282304`; semantic audit BLOCKER=0 |
| Auth/publish | не начато | B09 after B08 |
| Author AI helper | не начато | B10 |
| Florence migration | не начато | B11 |

## Canonical B07 publication

PR #27 merged as `1889145e1784e9186d0914207168448c111b8114`; exact `main` push CI `34102992250` succeeded. B07-01…04 and canonical B07 audit are closed.

## B08-01 — trusted plugin manifest / registry

Branch: `b08-01-plugin-manifest-registry`.  
PR: #28.  
Task: [B08-01](tasks/B08-01-plugin-manifest-registry.md).  
Decision: [ADR 0026](decisions/0026-trusted-plugin-manifest-registry.md).  
Audit: [B08-01 semantic audit](audits/2026-09-07-b08-01-semantic-audit.md).  
Worklog: [2026-09-07 B08-01](worklog/2026-09-07-b08-01.md).

### Accepted behavior

- canonical data-only manifest schema `1.0`;
- engine plugin API `1.0.0` with explicit deterministic version ranges;
- all plugin-owned IDs namespaced and bounded;
- duplicate IDs, missing/mismatched dependencies, cycles and global collisions fail closed;
- registry order deterministic and snapshot deeply frozen;
- release requirements explicitly report missing/incompatible plugin/capability/schema;
- no dynamic import, `eval`, `new Function`, network/process/filesystem/gameplay authority in registry package;
- generated agent docs expose only actually implemented registry metadata;
- current build advertises **zero installed plugins** and no resolver execution.

### Evidence

- initial implementation `f4ea4bca1f5fb170db81b456cf9c29de7abf00dd` → CI `34103718389` found only TS empty-tuple typing defect;
- fix `3bd15d318de0c94e5038a1af3f44148de794bfe0` → CI `34104110358` success;
- schema/generated-doc hardening head `adee3d4b2328d5fad5f56df9a347450d875fb496` → CI `34105282304` success;
- unresolved semantic `BLOCKER = 0`.

## B08-01 Publication Gate

Remaining:

1. final full CI on exact docs/current head;
2. mark PR #28 ready;
3. pinned merge at exact expected head;
4. exact merge-SHA push-to-main CI;
5. only then call B08-01 published;
6. create B08-02 exactly from verified B08-01 merge SHA.

## Next B08 slices

- **B08-02** — typed trusted backend plugin execution: read-only state + validated args + deterministic clock/RNG → typed action plan/effects; scheduler/effect namespace rules.
- **B08-03** — `dice-check` proof plugin + Studio schema/recipe + optional result UI; prove no plugin-specific conditional in Core and missing plugin blocks compatibility.

Weighted implementation estimate after canonical B07 publication: roughly **79–80%**. B08-01 is not counted as published until its exact main CI passes.
