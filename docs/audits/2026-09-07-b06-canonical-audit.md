# 2026-09-07 — Canonical B06 audit

Статус: **functional audit in progress; no unresolved BLOCKER found in code review before final B06-04 gate**.

Scope: B06-01 provider/connection/quota, B06-02 free-text intent, B06-03 narrator/FactPacket/fallback, B06-04 AgentBackend boundary/live-eval closure.

Классификация: `BLOCKER` / `FOLLOW_UP` / `LIMITATION` / `NO_FINDING`.

## 1. Authority

### ModelProvider не является gameplay authority

**NO_FINDING**

Evidence:

- `ModelProvider.generate` возвращает provider output/usage, не `WorldState`/effects/commit;
- B06-02 `validateIntentProposal` строит engine-owned `ResolvedIntent` только после exact allowlist validation;
- statePatch/effects/duration/resource delta/code/unknown action fields отклоняются;
- explicit и text сходятся в существующий Core resolver.

Regression: `packages/ai/test/intent.test.mjs`, `apps/server/test/runtime-intent.test.mjs`.

### Narrator не меняет Core result

**NO_FINDING**

Evidence:

- `FactPacket` строится после Core execution;
- narrator output содержит только summary/dialogue/observation refs;
- `statePatch`, effects, action mutation, unknown speaker/ref отклоняются;
- narrator failure после Core → deterministic fallback;
- action/playerView и narrative входят в один persisted response перед одним `commitTurn`.

Regression: `packages/ai/test/narrative.test.mjs`, `apps/server/test/runtime-narrative.test.mjs`.

### AgentBackend не расширяет gameplay authority

**NO_FINDING** для generic contract.

Evidence:

- `AgentBackend` отделён от `ModelProvider`;
- lifecycle API = open/runTurn/close;
- result = bounded text + usage/request evidence;
- нет API для WorldState/effects/cost/duration/commit;
- runtime-safe capabilities literal/validator требуют `toolPolicy:none` и false для shell/filesystem/code/repo/external tools.

Regression: `packages/ai/test/agent-backend.test.mjs`.

### Future AgentBackend wiring

**FOLLOW_UP**

Generic contract сам по себе не делает plain agent text игровым intent/narrative. Любой будущий adapter должен подавать output обратно в существующий strict intent/narrator consumer boundary. B06-04 не подключает AgentBackend к Runtime, поэтому второго gameplay path сейчас нет.

Owner: future bounded AgentBackend adapter slice only if a backend satisfies no-tools invariant.

## 2. Secrets / egress

### Connection credentials

**NO_FINDING**

- safe connection view содержит credential mask/revision, не raw secret;
- credential передаётся adapter отдельно и только Authorization header;
- URL userinfo/query/fragment запрещены;
- normalized provider errors не публикуют raw provider body;
- redirects запрещены.

Evidence: ADR 0018 + provider/connection tests.

### Static endpoint target policy

**NO_FINDING** в заявленном B06 scope.

Known literal loopback/private/link-local/metadata/reserved targets блокируются; explicit loopback HTTP только dev-policy.

### DNS-aware SSRF / egress isolation

**LIMITATION**

URL parser/static hostname checks не доказывают DNS rebinding/resolution-time egress isolation. Production deployment должен иметь transport/network egress policy.

Owner: deployment/security stage, не B06 gameplay logic.

### Agent auth/session secrets

**NO_FINDING** для generic contract.

`AgentBackendSafeView` не содержит credential/session token. `AgentSessionHandle.sessionRef` определён как opaque non-auth identifier. Production adapter отсутствует.

### Codex no-tools guarantee

**LIMITATION / compatibility verdict `limited`**

Current Codex snapshot supports auth/thread lifecycle and sandbox controls, но stable documented guarantee «all built-in tools absent» не подтверждён. `read_only` разрешает чтение файлов и не равен `toolPolicy:none`.

Evidence: `docs/spikes/2026-09-07-codex-agent-backend-compatibility.md`.

Consequence: production Codex Runtime adapter **не добавлен**.

## 3. Retry / deadline

### Stateless provider

**NO_FINDING**

OpenAI-compatible adapter не делает internal retry. Deadline absolute, AbortSignal поддержан, timeout/network/http normalized.

### Intent

**NO_FINDING**

Maximum 2 attempts; repair входит в лимит. Runtime claim происходит до AI.

### Narrator

**NO_FINDING**

Maximum 2 attempts; invalid/failed narrator после Core заканчивается deterministic fallback, не unbounded retry.

### Runtime combined budget

**NO_FINDING**

Один `aiDeadlineAtMs` создаётся после successful operation claim и один timestamp передаётся intent + narrator.

Regression: runtime narrative shared-deadline test.

### AgentBackend

**NO_FINDING** для contract/fake.

Open/run/close получают explicit absolute deadline + optional AbortSignal; expired/cancelled request fail before scripted backend step consumption.

### External provider SLA

**LIMITATION**

Deadline/cancellation policy ограничивает engine wait, но не доказывает SLA внешнего provider/backend.

## 4. Idempotency / commit

### Claim-before-AI

**NO_FINDING**

Text request hash строится по original input; `claimOperation` до interpreter. Replay не вызывает provider/Core снова.

### Processing outcomes

**NO_FINDING**

Clarification/unsupported/intent failed → `finishWithoutTurn`; revision/clock/resources unchanged.

### Calculated action

**NO_FINDING**

Core calculation → optional narrator/fallback → one `commitTurn`. Narrator failure после Core не откатывает действие.

### Replay narrative

**NO_FINDING**

Narrative сохраняется внутри operation public response; retry возвращает persisted payload без narrator/Core rerun.

Evidence: storage/runtime-intent/runtime-narrative tests.

## 5. Quota / usage

### Unknown vs zero

**NO_FINDING**

Unknown usage/quota = null; provider real zero сохраняется как zero.

### OpenRouter inference vs account management

**NO_FINDING**

Inference-key quota и account credits разделены; management credential отдельный; без него `permission_required`, не fabricated balance.

### Quota failure independence

**NO_FINDING**

Quota error не превращается в inference connection failure.

### AgentBackend quota

**LIMITATION**

Generic AgentBackend возвращает observed turn usage, но отдельный production Agent quota adapter не реализован, потому что production AgentBackend не принят. `QuotaMetricSource` уже допускает `agent_backend` для будущего adapter.

### Live eval usage

**NO_FINDING** по harness contract.

`eval:ai` суммирует только provider-reported usage; если хотя бы одна attempt metric unknown, aggregate остаётся null. Eval не меняет model/profile автоматически.

## 6. Public boundary

### Player WorldState exposure

**NO_FINDING**

Player получает deny-by-default projection, не full `WorldState`.

### Intent diagnostics

**NO_FINDING**

Public processing/failure response не публикует provider usage/request IDs/raw error body.

### Narrator diagnostics

**NO_FINDING**

Player narrative = profile/source/summary/dialogue/observationRefs. Internal narrator evidence/model/request IDs не публикуются.

### Agent diagnostics

**NO_FINDING** в current Runtime: AgentBackend не подключён к public Runtime path.

### Live eval artifacts

**NO_FINDING** по fixed harness design.

Eval использует fixed corpus и safe provider label, credential в result schema отсутствует. `not_configured` regression проверяет отсутствие unrelated secret echo.

## 7. Live semantic quality

### Harness exists

**NO_FINDING**

`npm run eval:ai` запускается явно; root `verify` его не запускает. Без `LHE_EVAL_API_KEY` + `LHE_EVAL_MODEL` возвращает `not_configured` с exit 0.

### Contract vs semantic scoring

**NO_FINDING**

Harness отдельно пишет `contractPass` и `semanticPass`, latency, attempts, observed model/usage/request IDs.

### Real configured provider run

**LIMITATION until credential is available in execution environment**

B06-04 tooling не имеет права читать/угадывать GitHub secrets. Если credential/profile не предоставлены текущему execution environment, live run честно остаётся `not_configured`; deterministic CI это не блокирует.

Owner: explicit operator live eval with configured `LHE_EVAL_*`.

## 8. Cross-block boundaries

### AI package coupling

**NO_FINDING pending final CI boundary check**

`@living-history/ai` остаётся provider/interpretation/presentation/session contract package и не импортирует Runtime/Core/Control/Player/apps.

### B07 leakage

**NO_FINDING**

B06-04 не добавляет PresentationPlan, assets, animation/audio, asset registry/prefetch или final presentation UI.

## 9. Audit result

Unresolved `BLOCKER`: **0**.

`FOLLOW_UP`:

1. любой future AgentBackend adapter обязан возвращаться в strict intent/narrator consumer boundary;
2. production network layer должен обеспечить DNS-aware egress isolation;
3. live real-model eval запускается оператором при наличии explicit credential/profile;
4. AgentBackend quota только после принятия конкретного production backend.

`LIMITATION`:

- Codex current verdict `limited` из-за недоказанного zero-built-in-tools mode;
- fake/deterministic tests не доказывают абсолютную semantic quality;
- external provider/backend SLA не доказывается engine deadline policy.

## 10. Closure condition

Audit становится final только после:

1. current B06-04 implementation CI green;
2. docs/ADR/worklog sync;
3. final current-head CI green;
4. pinned merge;
5. exact merge-SHA main CI green.

Только после этого B06 можно объявить canonical closed/published и переходить к B07.
