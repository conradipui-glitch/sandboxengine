# Статус движка

Последнее обновление: 2026-09-07.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B06-02 published; B06-03 functional gate green на PR #22** | B06-02 merge `90e6bcb4de1da2d0b37b5bc128406dcb0078b3a1`, main CI `34057996331`; B06-03 hardening head `12894d63…`, CI `34080825132` success → docs/current-head gate → merge/main CI |
| Контракты/Core | **B01–B03 published** | deterministic actions/effects/conditions/social/scheduler/RNG/replay |
| Runtime storage/API | **B04 published; B06-02/B06-03 AI pipeline integrated functionally** | claim-before-AI, idempotency/fencing/SQLite/guest HTTP, one commit with optional narrative |
| Authoring / Control | **B05 published** | authoritative draft → validation → frozen playtest → Player; T29 help/onboarding included |
| Runtime AI provider | **B06-01 published** | provider/connection/quota foundation; merge `a08f3434…`, main CI `34056977026` |
| Free-text intent | **B06-02 published** | merge `90e6bcb4…`, main CI `34057996331`; strict `IntentDecision`, same Core resolver, no-turn processing outcomes |
| Narration/fallback | **B06-03 accepted functionally на PR #22** | Core-derived FactPacket, strict/expressive narrator, deterministic fallback, shared deadline, T13/T14; ADR 0020 |
| Agent backend / B06 audit | не начато | B06-04 после публикации B06-03 |
| Presentation/assets | не начато | B07 |
| Plugins | не начато | B08 |
| Auth/publish | не начато | B09 |
| Author AI helper | не начато | B10 |
| Florence migration | не начато | B11 |

## Published through B06-02

Published B05 merge: `002c2cd7c802f06d23f62ac8cde726afef845c24`.  
Main CI: `34055962204` — success.

Published B06-01 merge: `a08f3434060abe699be5d431464597645557b8f9`.  
Main CI: `34056977026` — success.

Published B06-02 merge: `90e6bcb4de1da2d0b37b5bc128406dcb0078b3a1`.  
Main CI: `34057996331` — success.

Опубликованный causal путь теперь включает:

`Player input → Runtime claim/idempotency → optional strict intent understanding → ResolvedIntent → existing Core resolver → deterministic structured action result`.

`needs_clarification` / `unsupported` / intent `failed` завершаются без turn и без world mutation.

## B06-03 — narrator + FactPacket + deterministic fallback

Ветка: `b06-03-narrator-factpacket-fallback`.  
PR: #22.  
Карточка: [B06-03](tasks/B06-03-narrator-factpacket-fallback.md).  
Решение: [ADR 0020](decisions/0020-narrator-factpacket-single-commit-boundary.md).  
Worklog: [2026-09-07 B06-03](worklog/2026-09-07-b06-03.md).

### Реализовано

- versioned bounded `FactPacket` после Core calculation;
- narrator не получает full `WorldState`, resource min/max, items, contentHash или storage/fencing metadata;
- `strict` / `expressive` profiles имеют одинаковую authority boundary;
- exact narrative output: summary, bounded dialogue with allowed speaker IDs, allowed observation refs;
- unknown speaker/observation, `statePatch`, effects, action mutation, hidden refs и extra authority fields fail closed;
- deterministic local fallback для executed/partial/blocked;
- максимум 2 narrator attempts;
- один absolute AI deadline создаётся после claim и делится free-text intent + narrator;
- narrator вызывается после Core и до единственного `commitTurn`;
- narrator error/timeout/invalid output после Core → fallback, не rollback и не повторный Core calculation;
- committed public response сохраняет structured action/playerView + optional narrative;
- idempotent replay не повторяет intent/narrator/Core;
- Player принимает narrative backward-compatible: без narrator старый payload остаётся валиден;
- Player показывает только profile/source/summary/dialogue/observationRefs; provider evidence наружу не выходит;
- числовые gameplay поля остаются только structured `action`/`playerView`.

### T13/T14 evidence

Первый AI-layer CI `34058185395` выявил test-harness bug: тесты передавали абсолютный timestamp `10_000`, уже находившийся в прошлом относительно `Date.now()`. Production deadline policy не менялась; harness исправлен на future absolute deadline, expired test оставлен отдельным.

Implementation head `131ea960063ea2a0af7a9dd1a79abfa552af79ab` прошёл CI `34080761099` — success.

Final functional hardening head `12894d63bf64e290a854249438ec9f7c555177e1` прошёл PR CI `34080825132` — **success**, включая полный root `npm run verify`.

Проверено:

- broken narrator → deterministic fallback + exactly one committed turn;
- valid narrator не меняет canonical action/time/resource result;
- replay возвращает persisted narrative без новых narrator/Core calls;
- intent и narrator получают один exact absolute deadline;
- narrator input не содержит известных secret/internal fields;
- public narrative не публикует usage/model/provider attempt evidence;
- Player backward compatibility green;
- B01–B06-02 regressions green.

### Честная граница

Structural/fake regressions доказывают causal boundary, retry/fallback/idempotency и отсутствие разрешённых authority fields. Они **не доказывают качество живого русского narrator или отсутствие всех смысловых hallucinations expressive profile**. Это отдельный bounded live eval/manual playtest B06-04.

## Publication Gate B06-03

До слова **published** остаётся:

1. final current-head PR CI после ADR/STATUS/HANDOFF/worklog sync;
2. PR #22 mark ready;
3. merge с pinned expected head SHA;
4. push-to-main CI именно на merge SHA;
5. только после green main объявить B06-03 published.

После publication следующий bounded slice — **B06-04: AgentBackend/Codex compatibility spike + bounded live eval + canonical B06 audit**. Его ветку создавать только от verified B06-03 merge SHA.

## Scope boundary

B06-03 не содержит AgentBackend/Codex session implementation, final Studio connection UI, long-term dialogue/RAG memory, B07 presentation/assets/animations/audio, B08 plugins, B09 auth/public publish, B10 author AI или B11 Florence migration.

Known dependency vulnerabilities остаются отдельной задачей; force upgrade без отдельного аудита не выполняется.
