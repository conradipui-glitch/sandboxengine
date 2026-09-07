# Статус движка

Последнее обновление: 2026-09-07.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B06 published; B07-01 functional gate green на PR #24** | B06 final merge `7a5efba36b508f674483dd9cce3762277917c5e1`, main CI `34081697268`; B07-01 functional head `068890e3…`, CI `34083432560` success → docs/current-head gate → merge/main CI |
| Контракты/Core | **B01–B03 published** | deterministic gameplay authority; core contract schema remains `1.0` |
| Runtime storage/API | **B04 published** | idempotency/fencing/SQLite/guest HTTP |
| Authoring / Control | **B05 published** | authoritative draft → validation → frozen playtest → Player; T29 help/onboarding |
| AI foundation | **B06 published / canonical audit closed** | provider/intent/narrator/AgentBackend boundary; final merge `7a5efba36…`, main CI `34081697268`; audit unresolved BLOCKER=0 |
| Presentation contracts | **B07-01 accepted functionally** | separate presentation schema `2.0`, complete SceneFrameV2, bounded PresentationPlanV2, immutable asset refs, convergence/stale/replay; ADR 0022 |
| Asset ingestion/storage | не начато | B07-02 после publication B07-01 |
| Player presentation renderer | не начато | следующий B07 slice после asset boundary |
| Plugins | не начато | B08 |
| Auth/publish | не начато | B09 |
| Author AI helper | не начато | B10 |
| Florence migration | не начато | B11 |

## Published B06

Canonical B06 закрыт полностью.

- B06-01 merge `a08f3434060abe699be5d431464597645557b8f9`, main CI `34056977026`;
- B06-02 merge `90e6bcb4de1da2d0b37b5bc128406dcb0078b3a1`, main CI `34057996331`;
- B06-03 merge `a21e7cb9c19b873049bb941d34e0482d6c45568d`, main CI `34081046917`;
- B06-04/final merge `7a5efba36b508f674483dd9cce3762277917c5e1`, main CI `34081697268`.

Published calculated turn:

`Player input → Runtime claim/idempotency → optional strict intent → ResolvedIntent → Core → FactPacket → narrator/validator or deterministic fallback → structured public response → one commitTurn`.

Canonical B06 audit unresolved `BLOCKER = 0`. Current Codex verdict remains `limited / BUILTIN_TOOLS_CANNOT_BE_PROVEN_ABSENT`; production Codex Runtime adapter was intentionally not added.

## B07-01 — SceneFrameV2 + bounded PresentationPlanV2

Ветка: `b07-01-scene-frame-presentation-contracts`.  
PR: #24.  
Карточка: [B07-01](tasks/B07-01-scene-frame-presentation-contracts.md).  
Решение: [ADR 0022](decisions/0022-presentation-v2-final-frame-boundary.md).  
Worklog: [2026-09-07 B07-01](worklog/2026-09-07-b07-01.md).

### Почему presentation v2, а не widening v1

B01 уже опубликовал узкие `SceneFrame`/`PresentationPlan` schemas `1.0` и правило: breaking schema changes требуют нового `$id`.

Поэтому:

- core contracts остаются `1.0`;
- legacy presentation v1 остаётся frozen/readable;
- canonical B07 presentation получает отдельный `schemaVersion: 2.0`.

Generated agent contracts теперь явно показывают обе версии отдельно.

### SceneFrameV2

Полный player-safe конечный presentation frame:

- session/quest/release/revision/turn identity;
- immutable background ref;
- ordered actors/items/overlays;
- actor slots/expressions;
- dialogue history/current line;
- current music.

Reload обязан восстанавливать frame напрямую и не переигрывать старые эффекты.

### PresentationPlanV2

Bounded non-executable transition:

- one persisted `turnId`;
- `fromRevision → toRevision`;
- `targetFrameId`;
- `sequence` / `parallel`;
- only registered commands: background, actor show/hide/move/expression, item, dialogue, overlay, audio, wait;
- preset transitions/reveal/channel;
- bounded durations/tree depth/node count.

Arbitrary JS/HTML/CSS/DOM selectors/callbacks отсутствуют.

Animation/audio/typewriter completion не является gameplay commit или game-clock advancement.

### Asset reference boundary

B07-01 вводит immutable presentation identity `assetId + SHA-256 hash` и manifest DTO с MIME/dimensions/duration/alt/source/rights.

File upload, hash calculation, storage, MIME sniffing и deletion policy ещё **не реализованы** — это B07-02.

### Validation

Проверка разделена:

1. JSON Schema exact shape;
2. semantic membership: allowed scene/entity/speaker/overlay/assets, hash/kind, layer order, one-turn identity, tree bounds;
3. pure target-frame convergence.

После первого code-green audit найден и закрыт реальный gap: план с разрешённым, но другим background/actor slot мог пройти reference validation. Full gate теперь требует, чтобы детерминируемые presentation properties в конце совпадали с target SceneFrame.

Parallel conflicting writes fail closed; порядок children не используется как скрытый приоритет.

### Replay/stale helpers

- lower revision → stale;
- same frame/revision → duplicate;
- same revision + другой frame → conflict;
- already applied `turnId` не запускает plan снова;
- gap требует восстановить latest frame.

Skip/reduced-motion renderer в следующем B07 slice должен прийти к тому же target frame без gameplay callbacks.

### Evidence

Первый полный run `34082918924` подтвердил typecheck и весь B01–B06 code suite; единственным failure были ожидаемо stale generated agent docs.

Generated docs синхронизированы, registry hash: `0b1fa6e4e23374cc00fd5cca61ecbbc0aec2a5df3ab83c1da2ce82fb8cf6e36c`.

Final functional hardening head `068890e3bce15d0686b753df4d2f4ed1bcbda9f4` прошёл PR CI `34083432560` — **success**, полный `npm run verify`.

## Publication Gate B07-01

До слова **published** остаётся:

1. final current-head CI после ADR/STATUS/HANDOFF/worklog sync;
2. PR #24 mark ready;
3. merge с pinned expected head SHA;
4. exact merge-SHA push-to-main CI;
5. только после green main объявить B07-01 published.

После этого следующий bounded slice — **B07-02: immutable asset registry + validated ingestion/storage boundary**.

## Scope boundary

B07-01 не содержит file ingestion/storage, browser animation/audio executor, final Player visual redesign, Studio timeline editor, B08 UI plugins, B09 auth/public publish, B10 author AI или B11 Florence migration.

Known dependency vulnerabilities и production DNS-aware egress остаются отдельными deployment/dependency задачами; force upgrade без отдельного аудита не выполняется.
