# Статус движка

Последнее обновление: 2026-09-07.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B06-01 published; B06-02 functional gate green на PR #20** | B06-01 merge `a08f3434060abe699be5d431464597645557b8f9`, main CI `34056977026`; B06-02 CI `34057719194` success → final docs/current-head gate → merge/main CI |
| Контракты/Core | B01–B03 published | deterministic actions/effects/conditions/social/scheduler/RNG/replay |
| Runtime storage/API | **B04 published; B06-02 text route added functionally** | idempotency/fencing/SQLite/guest HTTP; claim-before-AI preserves T10–12/T15 |
| Authoring / Control | **B05 published** | authoritative draft → validation → frozen playtest → Player; T29 help/onboarding included |
| Runtime AI provider | **B06-01 published** | provider/connection/quota foundation; merge `a08f3434…`, main CI `34056977026` |
| Free-text intent | **B06-02 accepted functionally на PR #20** | strict `IntentDecision`, same Core resolver, no-turn processing outcomes, T02/T04/T09/T16; ADR 0019 |
| Narration/fallback | не начато | B06-03 после публикации B06-02 |
| Agent backend / B06 audit | не начато | B06-04 |
| Presentation/assets | не начато | B07 |
| Plugins | не начато | B08 |
| Auth/publish | не начато | B09 |
| Author AI helper | не начато | B10 |
| Florence migration | не начато | B11 |

## Published B05

PR #18 merged в `main` как `002c2cd7c802f06d23f62ac8cde726afef845c24`.  
Push-CI на exact merge SHA: `34055962204` — success.

B05 целиком published: Studio authoring, revision/conflict, validation, immutable frozen playtest, Player→Runtime/Core causal path, reset/idempotency proof и repeatable static Help/T29.

## Published B06-01

PR #19 merged в `main` как `a08f3434060abe699be5d431464597645557b8f9`.  
Push-CI на exact merge SHA: `34056977026` — success.

Опубликованный foundation:

- `@living-history/ai`;
- `ModelProvider.generate` + deterministic fake;
- bounded OpenAI-compatible adapter;
- OpenRouter/custom compatible connection contracts;
- safe credential/endpoint boundary;
- deadline/error/usage normalization;
- honest `QuotaMetric[]`, null-vs-zero, key/account separation, stale/cache semantics;
- ADR 0018.

## B06-02 — free-text intent boundary

Ветка: `b06-02-free-text-intent-boundary`.  
PR: #20.  
Карточка: [B06-02](tasks/B06-02-free-text-intent-boundary.md).  
Решение: [ADR 0019](decisions/0019-free-text-intent-shares-core-resolver.md).  
Worklog: [2026-09-07 B06-02](worklog/2026-09-07-b06-02.md).

### Реализовано

- strict `IntentDecision`: `resolved`, `needs_clarification`, `unsupported`, `failed`;
- model proposal не задаёт `sourceInput`; original text пришивается Engine после validation;
- exact-shape validation запрещает statePatch/effects/resource delta/duration/code и unknown mechanics;
- action catalog + args + entity allowlists;
- bounded interpreter: максимум 2 attempts, один absolute deadline;
- T02/T04/T09/T16 prepared fake corpus;
- legacy explicit request shape сохранён;
- new text request shape добавлен к тому же session action endpoint;
- request hash использует исходный text до AI;
- `claimOperation` происходит до provider call;
- explicit/text сходятся в общий Core helper → `resolvePaintAction` + canonical time planning;
- clarification/unsupported/failed завершаются через `finishWithoutTurn` без world/revision/time/resource mutation;
- clarification reference привязан к persisted no-turn operation + revision и проверяется до provider/Core;
- Player runtime template держит intent catalog рядом с exact frozen release/action definition.

### Functional evidence

Первый integration CI `34057574708` обнаружил два реальных compatibility-шва: explicit wrapper был случайно направлен через новый `executeIntent`, а optional clarification parser неверно проверял sorted keys. AI layer при этом уже был green 19/19; storage/control также green.

После compatibility corrections и frozen binding functional head `8e530be6232ce7cc2c0ed3c198eb84f6b44ba71e` прошёл PR CI `34057719194` — **success**, включая полный root `npm run verify` и старые B04/B05/T15 regressions.

### Честная граница

Fake/provider regressions доказывают contract, idempotency и causal boundary, но **не доказывают качество понимания живой русской моделью**. Полноценная semantic dialogue context orchestration не объявляется выполненной в B06-02.

## Publication gate B06-02

До слова **published** остаётся:

1. final current-head CI после ADR/STATUS/HANDOFF/worklog sync;
2. PR #20 mark ready;
3. merge с pinned expected head SHA;
4. push-to-main CI именно на merge SHA.

После green main B06-02 published. Следующий bounded slice — **B06-03 narrator + FactPacket + strict/expressive + deterministic template fallback + combined deadline/failure semantics**.

## Scope boundary

B06-02 не содержит narrator, FactPacket, финальный connection UI, Codex/AgentBackend session, новые gameplay mechanics, long-term dialogue/RAG memory, B07 presentation/assets, B08 plugins, B09 auth/public publish, B10 author AI или B11 Florence migration.

Known dependency vulnerabilities остаются отдельной задачей; force upgrade без отдельного аудита не выполняется.
