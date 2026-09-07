# Передача работы

Обновлено: 2026-09-07

Текущий блок: **B06-04 — AgentBackend + live eval + canonical B06 audit**  
База: published B06-03 merge `a21e7cb9c19b873049bb941d34e0482d6c45568d`  
B06-03 push-CI main: `34081046917` — success  
Ветка: `b06-04-agent-backend-live-eval-b06-audit`  
PR: #23  
Статус: **functional implementation CI `34081452303` success; canonical audit unresolved BLOCKER=0; docs/current-head CI → merge/main publication gate**

## Что уже published

B01–B05 и B06-01…03 published.

B06 published path на входе B06-04:

`claim → optional free-text intent → validated ResolvedIntent → Core → bounded FactPacket → narrator/fallback → one persisted commitTurn`.

Published evidence:

- B06-01 merge `a08f3434060abe699be5d431464597645557b8f9`, main CI `34056977026`;
- B06-02 merge `90e6bcb4de1da2d0b37b5bc128406dcb0078b3a1`, main CI `34057996331`;
- B06-03 merge `a21e7cb9c19b873049bb941d34e0482d6c45568d`, main CI `34081046917`.

## Что реализовано в B06-04

### AgentBackend boundary

`@living-history/ai` теперь имеет отдельный session-oriented `AgentBackend`:

- safe identity/capabilities;
- openSession / runTurn / closeSession;
- normalized auth/rate-limit/session-expired/timeout/abort/backend errors;
- absolute deadline + AbortSignal;
- observed usage/request IDs;
- opaque non-auth session reference.

Он не является `ModelProvider`, не подключён напрямую к Runtime gameplay path и не имеет методов WorldState/effects/Core/commit.

Runtime-safe profile жёстко требует:

- toolPolicy = none;
- shell = false;
- filesystem = false;
- codeExecution = false;
- repositoryMutation = false;
- externalToolCalls = false.

`assertRuntimeSafeAgentBackend` fail-closed отклоняет widening.

### Codex compatibility spike

Current `openai/codex` upstream snapshot проверен на session/auth/sandbox/tool semantics.

Совместимо по форме:

- API-key / ChatGPT browser/device auth;
- thread/session start/resume/turn lifecycle;
- cancellation/interrupt style primitives;
- sandbox selection.

Не доказано для Runtime:

- stable global zero-built-in-tools mode;
- read-only всё равно допускает filesystem reads и не равен `toolPolicy:none`.

Verdict:

`limited / BUILTIN_TOOLS_CANNOT_BE_PROVEN_ABSENT`

Поэтому production Codex Runtime adapter не добавлен. Нельзя заменять наш no-tools invariant более слабым read-only sandbox.

Spike: `docs/spikes/2026-09-07-codex-agent-backend-compatibility.md`.

### Live eval

Команда:

`npm run eval:ai`

Конфигурация:

- `LHE_EVAL_API_KEY`;
- `LHE_EVAL_MODEL`;
- optional `LHE_EVAL_BASE_URL`;
- optional `LHE_EVAL_OUTPUT`.

Harness не входит в deterministic `verify`.

Без key/model:

- status = `not_configured`;
- exit 0;
- no credential guessing;
- root CI remains deterministic.

Corpus:

- positive `core.paint`;
- T02/T04/T09/T16;
- unsupported action;
- executed/partial/blocked narration;
- strict + expressive.

Каждый case разделяет `contractPass` и `semanticPass`, пишет latency/attempts и только observed usage/model/request IDs.

### Canonical B06 audit

Audit: `docs/audits/2026-09-07-b06-canonical-audit.md`.

Проверено:

- authority;
- secrets/egress;
- retry/deadline;
- idempotency/single commit;
- quota/usage;
- public boundary;
- live-eval evidence boundary;
- B07 scope leakage.

Результат:

- unresolved BLOCKER = **0**;
- FOLLOW_UP: future AgentBackend adapter must return through strict validators; DNS-aware production egress; operator live eval; agent quota after concrete backend acceptance;
- LIMITATION: Codex current no-tools gap, external SLA, deterministic tests do not prove absolute language correctness.

### CI evidence

- `a9338a9556513a9e116714111f4323c4334603be` — AgentBackend contract/tests; CI `34081275103` success;
- `bc94fb98bddb36adc98abca929959da53b4355a9` — AgentBackend + `eval:ai` implementation; CI `34081452303` **success**.

ADR: `docs/decisions/0021-agent-backend-live-eval-and-b06-closure.md`.  
Worklog: `docs/worklog/2026-09-07-b06-04.md`.

## Functional acceptance state

Закрыто функционально:

- AgentBackend separate from ModelProvider;
- deny-by-default no-tools capability contract;
- deterministic lifecycle/deadline/error/usage tests;
- current Codex verdict with pinned upstream evidence;
- no unsafe production Codex adapter;
- explicit bounded live eval harness;
- no-credential clean skip + secret non-echo regression;
- canonical audit with zero unresolved BLOCKER;
- old B01–B06-03 root verify green;
- B07 scope not included.

## Честная граница

No live-provider run заявлять нельзя без explicit operator credential/model. Repository secrets не читаются и не угадываются.

`eval:ai` готов для explicit run; отсутствие credential = `not_configured`, не synthetic success.

## Publication Gate

Осталось:

1. final current-head PR CI после полного docs sync;
2. mark PR #23 ready;
3. pinned merge;
4. exact merge-SHA push-to-main CI;
5. после green main объявить B06-04 published и canonical B06 closed.

## Следующее после canonical B06 closure

**B07 — Presentation/assets**.

Стартовать отдельной bounded task-card/веткой только от verified B06-04 merge SHA.

B07 должен строить presentation layer поверх уже опубликованного structured action/playerView/narrative path, не возвращая AI presentation слою gameplay authority.

## Не делать сейчас

Production Codex adapter через read-only workaround, final Studio connection UI, long-term dialogue/RAG memory, B07 implementation внутри PR #23, B08 plugins, B09 auth/public publish, B10 author AI, B11 Florence migration или force dependency upgrade.
