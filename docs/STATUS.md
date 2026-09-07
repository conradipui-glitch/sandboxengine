# Статус движка

Последнее обновление: 2026-09-07.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B06-03 published; B06-04 functional gate green на PR #23** | B06-03 merge `a21e7cb9…`, main CI `34081046917`; B06-04 implementation CI `34081452303` success; canonical audit unresolved BLOCKER=0 → docs/current-head gate → merge/main CI |
| Контракты/Core | **B01–B03 published** | deterministic actions/effects/conditions/social/scheduler/RNG/replay |
| Runtime storage/API | **B04 published; full B06 Runtime AI path published through B06-03** | claim-before-AI, idempotency/fencing, no-turn processing, one commit, persisted narrative replay |
| Authoring / Control | **B05 published** | authoritative draft → validation → frozen playtest → Player; T29 help/onboarding |
| Runtime AI provider | **B06-01 published** | provider/connection/quota, OpenRouter/compatible foundation |
| Free-text intent | **B06-02 published** | strict intent boundary → existing Core resolver |
| Narration/fallback | **B06-03 published** | merge `a21e7cb9c19b873049bb941d34e0482d6c45568d`, main CI `34081046917`; FactPacket, shared deadline, deterministic fallback, one commit |
| Agent backend / B06 audit | **B06-04 accepted functionally на PR #23** | generic no-tools AgentBackend; Codex verdict `limited`; explicit `eval:ai`; canonical audit unresolved BLOCKER=0; ADR 0021 |
| Presentation/assets | не начато | B07 после публикации B06-04/canonical B06 closure |
| Plugins | не начато | B08 |
| Auth/publish | не начато | B09 |
| Author AI helper | не начато | B10 |
| Florence migration | не начато | B11 |

## Published through B06-03

B05 merge: `002c2cd7c802f06d23f62ac8cde726afef845c24`; main CI `34055962204` — success.  
B06-01 merge: `a08f3434060abe699be5d431464597645557b8f9`; main CI `34056977026` — success.  
B06-02 merge: `90e6bcb4de1da2d0b37b5bc128406dcb0078b3a1`; main CI `34057996331` — success.  
B06-03 merge: `a21e7cb9c19b873049bb941d34e0482d6c45568d`; main CI `34081046917` — success.

Canonical calculated turn:

`Player input → Runtime claim/idempotency → optional strict intent → ResolvedIntent → Core → FactPacket → narrator/validator or deterministic fallback → structured public response → one commitTurn`.

Processing outcomes (`needs_clarification` / `unsupported` / intent failure) завершаются без turn/world mutation. Narrator failure после Core не откатывает ход.

## B06-04 — AgentBackend + live eval + canonical B06 audit

Ветка: `b06-04-agent-backend-live-eval-b06-audit`.  
PR: #23.  
Карточка: [B06-04](tasks/B06-04-agent-backend-live-eval-b06-audit.md).  
Решение: [ADR 0021](decisions/0021-agent-backend-live-eval-and-b06-closure.md).  
Codex spike: [2026-09-07 Codex compatibility](spikes/2026-09-07-codex-agent-backend-compatibility.md).  
Canonical audit: [2026-09-07 B06 audit](audits/2026-09-07-b06-canonical-audit.md).  
Worklog: [2026-09-07 B06-04](worklog/2026-09-07-b06-04.md).

### Реализовано

- отдельный session-oriented `AgentBackend`, не `ModelProvider` alias;
- explicit open/runTurn/close lifecycle;
- normalized auth/rate-limit/session-expired/timeout/abort/backend errors;
- mandatory Runtime-safe `toolPolicy:none`;
- shell/filesystem/code execution/repository mutation/external tool calls = false;
- no gameplay mutation/Core/commit methods;
- safe view без raw credential/session token;
- deterministic `ScriptedAgentBackend` + lifecycle/deadline/no-tools regressions;
- current Codex compatibility spike;
- explicit `npm run eval:ai`, не включённый в deterministic root `verify`;
- live eval corpus для T02/T04/T09/T16/positive/unsupported intent и strict/expressive narration;
- separate `contractPass` vs `semanticPass`, latency/attempts/observed usage/model/request IDs;
- no credential/model → `not_configured`, exit 0;
- eval output schema не содержит credential; secret non-echo regression;
- canonical B06 audit по authority/secrets/deadlines/idempotency/quota/public boundaries.

### Codex verdict

Current upstream Codex session/auth lifecycle совместим по форме, но documented `read_only` sandbox всё равно допускает filesystem reads и не доказывает отсутствие built-in tools.

Verdict:

`limited / BUILTIN_TOOLS_CANNOT_BE_PROVEN_ABSENT`

Production Codex Runtime adapter в B06-04 **не добавлен**. Это deliberate safety decision, не незаконченная заглушка.

### Functional evidence

AgentBackend contract head `a9338a9556513a9e116714111f4323c4334603be` → CI `34081275103` — success.

AgentBackend + live-eval implementation head `bc94fb98bddb36adc98abca929959da53b4355a9` → CI `34081452303` — **success**, полный root `npm run verify`.

Canonical audit после green implementation gate:

- unresolved `BLOCKER`: **0**;
- FOLLOW_UP: future AgentBackend adapter must re-enter strict intent/narrator validators; production DNS-aware egress; explicit operator live eval; backend-specific quota only after backend acceptance;
- LIMITATION: current Codex no-tools guarantee, external provider SLA, deterministic tests != absolute language quality.

### Live model evidence boundary

Текущий GitHub/assistant tool boundary не раскрывает repository secrets, и B06-04 не пытается их читать/угадывать. Поэтому deterministic acceptance не содержит фиктивного claims о live provider run.

При explicit `LHE_EVAL_API_KEY` + `LHE_EVAL_MODEL` оператор может запустить `npm run eval:ai`. Без них результат clean `not_configured`.

## Publication Gate B06-04 / canonical B06

До слова **B06 closed/published** остаётся:

1. final current-head PR CI после ADR/STATUS/HANDOFF/worklog/audit sync;
2. PR #23 mark ready;
3. merge с pinned expected head SHA;
4. push-to-main CI именно на merge SHA;
5. только после green main объявить B06-04 published и canonical B06 closed.

После этого следующий bounded roadmap block — **B07 Presentation/assets**.

## Scope boundary

B06-04 не содержит production Codex adapter, final Studio connection UI, long-term dialogue/RAG memory, B07 PresentationPlan/assets/animations/audio, B08 plugins, B09 auth/public publish, B10 author AI или B11 Florence migration.

DNS-aware egress isolation и known dependency vulnerabilities остаются отдельными deployment/dependency задачами; force upgrade без отдельного аудита не выполняется.
