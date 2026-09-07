# ADR 0021 — AgentBackend отделён от ModelProvider; Codex limited; B06 закрывается canonical audit

Дата: 2026-09-07  
Статус: accepted в B06-04 после functional gate и canonical audit

## Контекст

B06-01…03 уже опубликовали production Runtime AI path:

`claim → optional free-text intent → Core → FactPacket → narrator/fallback → one commitTurn`.

Оставалось закрыть три вопроса:

1. как представлять stateful/session-oriented agent backends, не притворяясь, что это обычный stateless `ModelProvider`;
2. можно ли безопасно использовать current Codex как Runtime AI backend;
3. как отделить deterministic contract tests от реального language-quality eval и подтвердить, что B06 как целое не содержит unresolved security/causal blocker.

## Решение

### 1. `AgentBackend` — отдельный session-oriented contract

`@living-history/ai` вводит отдельную границу:

- safe backend identity/capabilities;
- `openSession`;
- bounded `runTurn`;
- `closeSession`;
- normalized auth/rate-limit/session-expired/timeout/abort/backend errors;
- observed usage/request IDs where available;
- absolute deadline + AbortSignal.

Он **не наследует и не заменяет `ModelProvider`**.

`AgentBackend` не содержит API для `WorldState`, effects, resource/time calculation, Core execution или commit.

### 2. Runtime-safe AgentBackend = no-tools by contract

Safe capability profile фиксирует:

- `toolPolicy: "none"`;
- shell = false;
- filesystem = false;
- codeExecution = false;
- repositoryMutation = false;
- externalToolCalls = false.

`assertRuntimeSafeAgentBackend` fail-closed отклоняет widening.

Это сильнее sandbox read-only: Runtime backend не должен даже иметь capability surface, через который можно читать workspace/host или выполнять команды.

### 3. Codex current verdict = `limited`

Проверка current upstream `openai/codex` snapshot показала:

- auth/login и thread/session lifecycle совместимы по форме;
- public SDK поддерживает API-key, ChatGPT/browser/device login, thread start/resume и turns;
- documented sandbox modes включают read-only/workspace-write/full-access;
- read-only разрешает чтение файлов и поэтому не равен `toolPolicy:none`;
- стабильная documented global guarantee «all built-in tools absent» не подтверждена; upstream feature request на disable built-in tools остаётся релевантным.

Поэтому B06-04 **не добавляет production Codex Runtime adapter**.

Verdict:

`limited / BUILTIN_TOOLS_CANNOT_BE_PROVEN_ABSENT`

Это compatibility limitation, не blocker опубликованного Runtime path, потому что AgentBackend не подключён к gameplay Runtime.

### 4. Future AgentBackend output всё равно не становится authority

Если в будущем backend станет совместимым, его текст должен возвращаться в существующий strict consumer boundary:

- intent → `validateIntentProposal` → engine-owned `ResolvedIntent` → Core;
- narration → `FactPacket` + `validateNarrativeProposal` / deterministic fallback.

Нельзя подключать agent plain text напрямую к gameplay state/commit.

### 5. Live eval отделён от deterministic CI

Добавлен explicit `npm run eval:ai`.

Он конфигурируется только явными `LHE_EVAL_*` переменными и не входит в root `verify`.

Без `LHE_EVAL_API_KEY` + `LHE_EVAL_MODEL` результат:

`status: not_configured`

с exit 0. Credential не угадывается и отсутствие live key не делает deterministic CI красным.

### 6. Eval разделяет contract и semantic quality

Fixed corpus включает positive paint, T02/T04/T09/T16/unsupported intent и executed/partial/blocked strict/expressive narration.

Каждый case отдельно фиксирует:

- `contractPass`;
- `semanticPass`;
- latency;
- attempts;
- provider-reported usage (unknown остаётся null);
- observed model/request IDs where supplied.

Eval не меняет production model/profile автоматически.

### 7. Eval artifacts не содержат credential

Result schema не имеет credential поля. Provider label строится без userinfo/query/fragment. Fixed corpus не включает пользовательские secrets.

Regression запускает harness без credentials и проверяет clean `not_configured` + отсутствие unrelated secret sentinel в stdout/stderr.

### 8. Canonical B06 audit обязателен перед closure

Audit: `docs/audits/2026-09-07-b06-canonical-audit.md`.

Проверены:

- authority;
- secrets/egress;
- retry/deadline;
- idempotency/commit;
- quota/usage;
- public boundary;
- live semantic quality separation;
- cross-package/scope boundaries.

На functional gate unresolved `BLOCKER` = **0**.

### 9. Known limitations не маскируются под bugs

Остаются отдельно:

- DNS-aware SSRF/egress isolation — deployment/network layer;
- current Codex no-tools guarantee — upstream/backend limitation;
- real live-model quality — operator `eval:ai` при explicit credential/profile;
- external provider SLA — не доказывается engine deadlines;
- AgentBackend-specific quota — только после принятия concrete production backend.

Они не нарушают causal/security invariants текущего production Runtime path.

## Доказательство

Deterministic evidence:

- `packages/ai/test/agent-backend.test.mjs` — lifecycle/no-tools/deadline/cancel/error/usage contract;
- `packages/ai/test/live-eval-script.test.mjs` — no-credential clean skip + secret non-echo;
- existing B06-01…03 provider/quota/intent/narrative/runtime/storage/player regressions;
- root boundary/docs checks.

AgentBackend contract head `a9338a9556513a9e116714111f4323c4334603be` прошёл CI `34081275103` — success.

AgentBackend + live-eval implementation head `bc94fb98bddb36adc98abca929959da53b4355a9` прошёл CI `34081452303` — success.

Canonical audit после этого не выявил unresolved BLOCKER.

## Не решено этим ADR

- production Codex Runtime adapter;
- DNS-aware deployment egress layer;
- real live eval без предоставленного operator credential;
- final Studio connection-management UX;
- B07 PresentationPlan/assets/animations/audio;
- B08 plugins;
- B09 auth/public publish;
- B10 author AI;
- B11 Florence migration.

## Closure rule

B06-04 и canonical B06 считаются published/closed только после:

1. ADR/STATUS/HANDOFF/worklog sync;
2. final current-head PR CI success;
3. pinned merge;
4. exact merge-SHA push-to-main CI success.

После этого следующий bounded roadmap block — B07 Presentation/assets, если новый внешний blocker не появился.
