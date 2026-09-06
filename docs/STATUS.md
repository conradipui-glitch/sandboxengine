# Статус движка

Последнее обновление: 2026-09-07.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B05 published; B06-01 functional gate green на PR #19** | B05 merge `002c2cd7c802f06d23f62ac8cde726afef845c24`, main CI `34055962204`; B06-01 hardened CI `34056571152` success → final docs/current-head gate → merge/main CI |
| Контракты/Core | B01–B03 published | deterministic actions/effects/conditions/social/scheduler/RNG/replay |
| Runtime storage/API | **B04 published** | idempotency/fencing/SQLite/guest HTTP; T10–12/T15 |
| Authoring / Control | **B05 published** | authoritative draft → validation → frozen playtest → Player; T29 help/onboarding included |
| Runtime AI provider | **B06-01 accepted functionally на PR #19** | `@living-history/ai`, compatible adapter, OpenRouter/custom connections, T30/T31 quota contracts; ADR 0018 |
| Free-text intent | не начато | B06-02 after B06-01 publication |
| Narration/fallback | не начато | B06-03 |
| Agent backend / B06 audit | не начато | B06-04 |
| Presentation/assets | не начато | B07 |
| Plugins | не начато | B08 |
| Auth/publish | не начато | B09 |
| Author AI helper | не начато | B10 |
| Florence migration | не начато | B11 |

## Published B05

PR #18 merged в `main` как `002c2cd7c802f06d23f62ac8cde726afef845c24`.  
Push-CI на exact merge SHA: `34055962204` — success.

B05 теперь целиком published: Studio authoring, revision/conflict, validation, immutable frozen playtest, Player→Runtime/Core causal path, reset/idempotency proof и repeatable static Help/T29.

## B06-01 — provider/connection/quota foundation

Ветка: `b06-01-provider-connection-quota-contracts`.  
PR: #19.  
Карточка: [B06-01](tasks/B06-01-provider-connection-quota-contracts.md).  
Решение: [ADR 0018](decisions/0018-runtime-ai-provider-connection-quota-boundary.md).  
Worklog: [2026-09-07 B06-01](worklog/2026-09-07-b06-01.md).

### Реализовано

- отдельный `@living-history/ai` workspace;
- stable `ModelProvider.generate` + deterministic fake;
- bounded OpenAI-compatible Chat Completions adapter;
- OpenRouter preset + explicit compatible endpoint;
- safe connection view без raw credential;
- connection capability test без guessing;
- absolute deadline/abort, no adapter retries, sanitized errors;
- honest optional usage/model/request IDs;
- static endpoint target policy + redirect prohibition;
- `QuotaAdapter`/`QuotaMetric` with null-vs-zero semantics;
- inference-key quota отдельно от account management credits;
- optional management credential / `permission_required`;
- explicit reset timestamp preservation, no invented reset from `monthly`;
- credential/account/revision-aware quota cache + `stale` state;
- `test:ai` включён в root verify;
- architectural boundary запрещает gameplay/UI/storage coupling.

### T30/T31 evidence

Functional hardened head `64c644eee9e9bf66c199b082d12efedf25c9fa7f` прошёл PR CI `34056571152` — **success**, включая root `npm run verify`.

До этого CI также зафиксировал lockfile bootstrap correction: initial `npm ci` failed on unsynced new workspace, после lock sync полный verify green. Это инфраструктурное расхождение устранено в ветке.

## Publication gate B06-01

До слова **published** остаётся:

1. final current-head CI после docs sync;
2. PR #19 mark ready;
3. merge с pinned expected head SHA;
4. push-to-main CI именно на merge SHA.

После green main B06-01 published. Следующий bounded slice — **B06-02 free-text intent boundary**; не смешивать его с PR #19.

## Scope boundary

B06-01 не содержит free-text gameplay route, narrator, Codex/AgentBackend session implementation или final Studio connection UI.

Known dependency vulnerabilities остаются отдельной задачей; force upgrade без отдельного аудита не выполняется.
