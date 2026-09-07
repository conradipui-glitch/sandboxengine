# B06-04 — AgentBackend/Codex compatibility spike + bounded live eval + canonical B06 audit

## Цель

Закрыть B06 как целостный Runtime AI subsystem, не смешивая опубликованный stateless `ModelProvider`/intent/narrator path с session-oriented agent backends.

B06-04 должен:

1. определить отдельный bounded `AgentBackend` contract;
2. провести Codex-style compatibility spike без объявления spike production dependency;
3. добавить bounded live eval для intent + narrator через существующий provider boundary;
4. провести canonical audit B06-01…03 по authority, secrets, deadlines/retries, quotas, idempotency, fallback и public diagnostics;
5. устранить только реальные B06 closure gaps, не заходя в B07 presentation/assets.

## Канонический вход

- B01–B05 published;
- B06-01 published: merge `a08f3434060abe699be5d431464597645557b8f9`, main CI `34056977026` success;
- B06-02 published: merge `90e6bcb4de1da2d0b37b5bc128406dcb0078b3a1`, main CI `34057996331` success;
- B06-03 published: merge `a21e7cb9c19b873049bb941d34e0482d6c45568d`, main CI `34081046917` success;
- canonical calculated turn: `claim → optional intent → Core → FactPacket → narrator/fallback → one commitTurn`;
- fake regressions доказывают structural/causal safety, но не quality конкретной live model.

## Главный invariant

**Agent/session integration и live eval не получают gameplay authority и не расширяют права уже опубликованного Core/intent/narrator boundary.**

B06-04 не должен:

- превращать Codex login/session workflow в обязательную Runtime dependency;
- маскировать stateful `AgentBackend` под stateless `ModelProvider`;
- позволять agent backend писать `WorldState`, effects, duration/resource cost или commit;
- переносить secrets/session tokens в browser, quest JSON, logs или public response;
- создавать nested/unbounded retry loops;
- считать live eval доказательством абсолютного отсутствия hallucinations;
- добавлять B07 assets/animations/audio/presentation planner.

## Сделать

### 1. Отдельный `AgentBackend` contract

В `@living-history/ai` определить минимальную session-oriented границу отдельно от `ModelProvider`:

- backend identity/capabilities;
- explicit session lifecycle (`open` / bounded request-turn / `close`);
- normalized success/error;
- absolute deadline / AbortSignal;
- explicit rate-limit/auth/session-expired outcomes where observable;
- opaque secret/session references, не raw token в safe view;
- no gameplay mutation methods.

### 2. Codex compatibility spike

Проверить фактически:

- можно ли безопасно открыть/использовать/закрыть bounded session;
- какие auth/login prerequisites существуют;
- какие errors/rate-limit/session expiry реально наблюдаемы;
- можно ли передать bounded prompt/context без repo/files/shell/tools authority;
- можно ли гарантировать no-tools Runtime profile;
- где проходит граница inference/chat vs coding-agent semantics.

Если безопасная/стабильная Runtime интеграция не подтверждается — зафиксировать `limited` или `unsupported_for_runtime`, а не выдумывать production adapter.

### 3. No-tools default

Runtime-oriented AgentBackend profile deny-by-default:

- no shell/filesystem/code execution;
- no GitHub/Drive/web tools;
- no arbitrary network/tool calls;
- no repository mutation.

Если backend не позволяет доказать такой режим, он не считается допустимым Runtime intent/narrator backend.

### 4. Bounded live eval harness

Добавить отдельный `eval:ai` (или эквивалент), который не ломает deterministic CI без credentials.

Intent corpus минимум:

- T02 negation/hypothetical;
- T04 request/permission/response ownership;
- T09 multi-action clarification;
- T16 prompt injection/privileged-field resistance;
- positive `core.paint` commands with units;
- unsupported mechanic.

Narrator corpus минимум:

- executed / partial / blocked FactPacket;
- strict profile;
- expressive profile отдельно.

### 5. Eval scoring без самообмана

Разделить:

- `contractPass` — strict validator/authority boundary;
- `semanticPass` — fixture expectation;
- latency;
- attempts;
- reported usage only when provider supplies it;
- observed model/provider identity.

Unknown usage = null, не zero. Eval не меняет production model/profile автоматически.

### 6. Bounded budget

Spike/eval обязаны иметь:

- absolute deadline;
- cancellation;
- bounded attempts;
- no hidden adapter retries;
- sanitized errors;
- no secret echo.

Published Runtime one-deadline intent+narrator invariant не меняется.

### 7. Canonical B06 audit

Проверить B06-01…03 по матрице.

#### Authority
- ModelProvider output = proposal/presentation only;
- intent не считает effects/time/cost/state;
- narrator не меняет Core result;
- AgentBackend не имеет gameplay mutation API.

#### Secrets / egress
- credentials отсутствуют в safe views/public responses/URLs;
- endpoint policy fail-closed для известных dangerous targets;
- redirects prohibited;
- DNS-aware egress limitation честно документирована;
- agent auth/session tokens server-side opaque.

#### Retry / deadline
- provider no internal retry;
- intent max 2;
- narrator max 2;
- one Runtime operation deadline intent+narrator;
- AgentBackend не создаёт nested unbounded retry.

#### Idempotency / commit
- claim-before-AI;
- processing outcomes no-turn;
- calculated action exactly one commit;
- replay no additional AI/Core;
- narrator failure after Core → fallback, not rollback.

#### Quota / usage
- unknown != zero;
- inference key vs management credential separated;
- quota failure не фабрикует inference failure;
- eval reports only observed usage.

#### Public boundary
- no full WorldState;
- no provider diagnostics/attempt evidence in Player narrative;
- no agent tokens/session internals;
- structured action/playerView остаются gameplay source of truth.

### 8. Findings policy

Каждое найденное расхождение классифицировать:

- `BLOCKER` — нарушает B06 invariant/security/causal correctness; исправить в B06-04;
- `FOLLOW_UP` — относится к B07+/deployment/UX; записать следующий owner/slice;
- `LIMITATION` — честная граница доказательства/provider behavior;
- `NO_FINDING` — invariant подтверждён evidence.

### 9. Tests

Deterministic tests минимум:

- fake AgentBackend lifecycle + normalized errors;
- no-tools/default capability denial;
- agent result не может нести gameplay mutation authority;
- secret/session safe view;
- deadline/cancellation bounded;
- machine-checkable B06 audit invariants where practical;
- old B01–B06-03 `npm run verify` green.

Live eval:

- запускается явно при configured credential/connection;
- no credential → clean `skipped/not_configured`, не падение root CI;
- result artifact redacts secrets;
- фиксирует model/provider/time/semantic+contract result.

## Functional acceptance

B06-04 functional gate закрыт, когда:

1. `AgentBackend` отделён от `ModelProvider` и не имеет gameplay mutation API;
2. Codex compatibility spike даёт честный bounded результат (`compatible`, `limited` или `unsupported_for_runtime`) с evidence;
3. no-tools authority доказана либо incompatibility явно зафиксирована;
4. live eval harness отделяет contract correctness от semantic quality;
5. реально configured live provider/model прогоняется, **если credential доступен**; отсутствие credential не блокирует deterministic CI;
6. canonical B06 audit завершён без unresolved `BLOCKER`;
7. closure gaps, если найдены, имеют regressions;
8. root `npm run verify` green;
9. B07 scope не вошёл в PR.

## Честная граница

B06-04 не доказывает absolute semantic correctness будущих моделей, production SLA provider, DNS-aware egress isolation одной URL validation или безопасность arbitrary agent tools. Runtime profile обязан не выдавать agent tools.

## Не делать

Production coding-agent с shell/filesystem/GitHub authority внутри gameplay turn, automatic router redesign, long-term RAG/dialogue memory, final Studio connection UI, B07 PresentationPlan/assets/audio, B08 plugins, B09 auth/public publish, B10 author AI, B11 Florence migration или force dependency upgrade.

## Publication Gate

После functional acceptance:

1. ADR/STATUS/HANDOFF/worklog sync;
2. final current-head CI;
3. pinned merge;
4. exact merge-SHA push CI;
5. canonical B06 объявляется closed/published только после green main.

Ожидаемый следующий roadmap block после canonical B06 closure — **B07 Presentation/assets**, если audit не выявит blocker, требующий отдельного bounded correction slice.
