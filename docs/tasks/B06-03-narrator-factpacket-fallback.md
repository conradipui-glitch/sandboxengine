# B06-03 — Narrator + FactPacket + deterministic fallback / T13 T14

## Цель

Добавить второй Runtime AI stage после уже рассчитанного Core action: narrator может оформить разрешённые факты для игрока, но **не может изменить действие, WorldState, числовой результат, участников, speaker ownership или открыть скрытые данные**.

B06-03 закрывает narrator/fallback часть B06 и объединяет intent+narrator под один bounded AI deadline. `AgentBackend`/Codex compatibility и финальный B06 audit остаются B06-04.

## Канонический вход

- B01–B05 published;
- B06-01 published: provider/connection/quota foundation;
- B06-02 published: merge `90e6bcb4de1da2d0b37b5bc128406dcb0078b3a1`, main push-CI `34057996331` success;
- free-text intent уже claim-before-AI и сходится с explicit action в один Core resolver;
- `needs_clarification` / `unsupported` / intent `failed` уже завершаются без turn;
- canonical SPEC §9.1–9.6, §17.2–17.4, T13/T14.

## Главный invariant

**Narrator оформляет уже разрешённые факты; gameplay truth остаётся Core + structured public data.**

Narrator никогда не имеет права:

- менять candidate WorldState;
- менять `action.status`, requested/completed units, duration, reason code или resource balances;
- добавлять action/effect/statePatch/task/item/NPC/resource/location;
- приписывать игроку решение, эмоцию или согласие;
- говорить от имени отсутствующего/неразрешённого speaker;
- ссылаться на скрытый asset/entity/fact;
- превращать narrator error в rollback уже рассчитанного action;
- запускать бесконечные retries/validator-model loops.

## Сделать

### 1. `FactPacket` contract

Добавить versioned structured packet, который формируется **из Core-calculated execution + safe public projection**, до narrator call.

Минимум:

- action identity/type;
- canonical structured action result (`executed` / `partial` / `blocked` where applicable);
- requested/completed units;
- duration/reason;
- before/after public clock/resource observations needed for narration;
- allowed visible entity/speaker IDs;
- allowed observation IDs/text snippets if present;
- explicit allowed continuation/action labels where available;
- no secret WorldState fields.

Числовые остатки и системные подписи Player берёт из structured data/public view, не из narrator prose.

FactPacket должен быть serializable/frozen and bounded; narrator receives no full WorldState.

### 2. Narrative profiles

Добавить два profile IDs:

- `strict` — regression/default-safe profile;
- `expressive` — richer wording, still same structural authority boundary.

Оба получают один и тот же FactPacket. Profile меняет только style/output budget/instructions, не права и не allowed IDs.

B06-03 не утверждает, что structural validation устраняет все смысловые hallucinations. Expressive остаётся предметом будущего/manual playtest.

### 3. Narrator output contract

Narrator возвращает bounded structured draft, например:

- `summary` / scene text;
- optional dialogue entries with **speakerId only from FactPacket allowlist**;
- optional references only to allowed observation IDs.

Exact-shape validator отклоняет:

- unknown speaker/entity/observation IDs;
- effects/statePatch/action mutation fields;
- hidden asset IDs;
- empty/oversized output;
- extra keys that расширяют authority.

Unknown/invalid structure → deterministic local fallback, not a second gameplay calculation.

### 4. Deterministic template renderer

Для каждого calculated result должен существовать local template, который без LLM объясняет минимум:

- что игрок попытался сделать;
- что реально выполнено;
- если partial/blocked — что не выполнено и почему;
- elapsed duration where relevant;
- no fabricated speaker/asset.

Template uses only structured FactPacket and is deterministic for identical packet/profile-independent fallback.

Пустая сцена, повтор предыдущей реплики и отсутствие понятного результата не допустимы как fallback.

### 5. Bounded narrator pipeline

Добавить `Narrator` поверх `ModelProvider.generate`.

Требования:

- максимум 2 narrator attempts;
- repair входит в эти 2 attempts;
- one absolute deadline from Runtime operation;
- no internal retry in provider adapter;
- timeout/network/invalid/empty after budget → local template;
- usage/model/provider request IDs are evidence only;
- narrator failure никогда не отменяет/пересчитывает Core action.

### 6. Один AI deadline на free-text turn

Для free-text operation один absolute deadline создаётся после successful claim и используется:

1. intent stage;
2. narrator stage на оставшемся времени.

Штатный free-text turn: максимум один successful intent call + один successful narrator call. Retry budget остаётся максимум 2+2 attempts, но **все attempts входят в один общий 25s deadline**.

Если intent исчерпал deadline/attempt budget → no turn, как в B06-02.

Если Core уже рассчитан, а narrator исчерпал остаток deadline → deterministic fallback + один commit.

Explicit button action bypasses intent and может использовать narrator/fallback под тем же operation deadline policy.

### 7. Commit order

Pipeline для calculated action:

1. claim operation;
2. optional intent → validated `ResolvedIntent`;
3. Core calculates candidate state/action result;
4. build FactPacket from Core result + safe public projection;
5. narrator attempt(s) within remaining deadline;
6. validate narrative or choose deterministic fallback;
7. build public response with structured action/playerView + narrative;
8. **one** `commitTurn`.

Ни narrator success, ни fallback не запускают Core повторно.

Idempotent replay возвращает persisted narrative/public response и не вызывает provider.

### 8. T13 — failure semantics

Закрепить отдельно:

- intent timeout / invalid JSON after bounded attempts → `failed` without turn;
- narrator timeout → fallback + exactly one committed turn;
- narrator invalid JSON/empty output → fallback + exactly one committed turn;
- paid failed attempts may still have usage evidence, but unknown usage is not zero.

### 9. T14 — structural narrator safety

Prepared narrator outputs must prove:

- unknown/absent speaker ID → rejected → fallback;
- illegal `effects` / `statePatch` / action mutation field → rejected → fallback;
- hidden/unknown asset or observation reference → rejected → fallback;
- valid allowed speaker/observation structure → accepted;
- public response never exposes full secret WorldState or provider diagnostics.

### 10. Player/public response compatibility

Существующие structured `action` and `playerView` поля остаются canonical source for gameplay UI.

Добавить narrative field in backward-compatible way. B05 Player не обязан получить финальный B07 presentation system; достаточно текстового safe surface/fallback.

Narrative text не должен заменять числовые resource/time/action поля.

### 11. Tests

Расширить `test:ai`, `test:server`, при необходимости `test:player`.

Минимум:

- FactPacket excludes secret state and includes canonical result;
- deterministic fallback for executed/partial/blocked-supported fixtures;
- strict/expressive share same allowlists/authority;
- max 2 narrator attempts;
- combined free-text deadline is one absolute value across intent+narrator;
- narrator timeout/invalid/empty → fallback + one commit;
- T14 unknown speaker/effect/hidden ref → fallback;
- valid narrator accepted without changing action/playerView;
- replay does not re-run intent, narrator or Core;
- old B05/B06-02 structured action path remains green;
- root `npm run verify` green.

## Functional acceptance

B06-03 functional gate считается закрытым, когда:

1. calculated explicit/text action produces FactPacket only from trusted structured result/public data;
2. valid narrator can add bounded presentation text but cannot alter structured gameplay fields;
3. broken narrator always yields deterministic understandable fallback and exactly one committed turn;
4. T13/T14 regressions green;
5. free-text intent+narrator share one 25s absolute deadline;
6. idempotent retry performs no additional AI/Core work;
7. `npm run verify` green;
8. no AgentBackend/Codex/B06-04 scope entered the PR.

## Не делать

- `AgentBackend`/Codex login/session/rate-limit compatibility — B06-04;
- final live-provider language/narrative quality claim without bounded eval;
- second LLM fact-checker/validator model;
- arbitrary generative facts/world proposals;
- new NPC/items/resources/deals from runtime prose;
- final B07 PresentationPlan/assets/animations/audio system;
- final Studio connection UI;
- long-term RAG/dialogue memory;
- B08 plugins, B09 auth/publish, B10 author helper, B11 Florence migration.

## Следующий slice

После published B06-03: **B06-04 — AgentBackend/Codex compatibility spike + bounded live eval + canonical B06 audit**. Создать отдельную ветку только от verified B06-03 merge SHA.
