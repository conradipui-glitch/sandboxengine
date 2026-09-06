# Передача работы

Обновлено: 2026-09-07

Текущий блок: **B06-01 — Provider, connection and quota contracts / T30–31**  
База: published B05 merge `002c2cd7c802f06d23f62ac8cde726afef845c24`  
B05 push-CI main: `34055962204` — success  
Ветка: `b06-01-provider-connection-quota-contracts`  
PR: #19  
Статус: **functional T30/T31 gate `34056571152` success; docs sync → final current-head CI → merge/main publication gate**

## Что уже published

B01–B05 published.

B05 canonical path:

- authoritative Studio draft/revision/conflict;
- validation;
- immutable frozen playtest;
- Player bootstrap from frozen record;
- Runtime/Core-only gameplay calculation;
- P1/P2 cost=1→2 proof;
- reset and idempotent retry;
- repeatable static Help/onboarding T29.

Published B05 merge: `002c2cd7c802f06d23f62ac8cde726afef845c24`.  
Main CI: `34055962204` — success.

## Что реализовано в B06-01

### Provider/connection boundary

Новый `@living-history/ai` даёт:

- `ModelProvider.generate` contract;
- deterministic scripted provider;
- bounded OpenAI-compatible Chat Completions adapter;
- OpenRouter + custom compatible presets;
- separate Connection/ModelProfile;
- safe connection view без raw credential;
- connection capability test;
- absolute deadline/AbortSignal;
- normalized/sanitized errors and optional honest usage/model/request IDs;
- no internal provider retries.

Credential остаётся opaque header-only secret. CR/LF запрещены; URL punctuation внутри ключа не интерпретируется как URL.

Endpoint validation — syntactic target policy: HTTPS public by default, explicit loopback dev HTTP, static private/metadata/reserved targets blocked, redirects disabled. DNS-aware egress isolation требуется deployment/transport layer и не объявляется решённой одним URL parser.

### Quota boundary

- independent `QuotaAdapter` / `QuotaMetric[]`;
- real zero сохраняется, unknown = null;
- OpenRouter `/key` uses inference credential;
- `/credits` only with separate management credential;
- without management credential => `permission_required`, no fabricated balance;
- quota failure не инвалидирует inference provider;
- period `monthly` не превращается в guessed reset date;
- explicit ISO reset сохраняется;
- cache identity = connection/account/credential revision;
- expired available metric = `stale`.

ADR: `docs/decisions/0018-runtime-ai-provider-connection-quota-boundary.md`.

## CI evidence

- `e4d21dfe4be676b5f467421bf48f2f046eae5a7b`: initial workspace; CI `34056350198` выявил unsynced package-lock на npm-ci stage;
- `4ed048fcd292f4c90ce36015e14d3fd6152fa10a`: lock sync; CI `34056391413` success;
- `156c8ee420b4533cce5d48a7a5b6106d08e6c1bf`: opaque credential hardening; CI `34056470699` success;
- `64c644eee9e9bf66c199b082d12efedf25c9fa7f`: final T30/T31 hardening; CI `34056571152` **success**.

## Acceptance state

Закрыто функционально:

- provider contract + deterministic fake;
- OpenRouter/custom compatible connection behavior;
- capability check without guessing;
- deadline/error/usage semantics;
- secret isolation in safe views/URLs/errors;
- T30-level connection regression;
- T31 quota null/zero/permission/cache/reset semantics;
- old B01–B05 regressions green;
- root boundaries/docs checks green.

Остался Publication Gate:

1. final current-head PR CI после docs sync;
2. mark PR #19 ready;
3. merge с expected head SHA;
4. verify push-to-main CI on exact merge SHA;
5. только после green main объявить B06-01 published.

## Следующее после публикации B06-01

**B06-02 — free-text intent boundary**:

- interpreter output contract / prepared fake responses;
- `ResolvedIntent` без statePatch/time cost;
- rights/reference/precondition filters;
- `needs_clarification` / `unsupported` без turn mutation;
- negation/hypothetical/deferred/multi-action/missing-target tests;
- confirmed intent идёт в **тот же existing Core resolver**, что explicit action;
- narrator ещё не добавлять.

Создать B06-02 отдельной bounded task-card/веткой **точно от verified B06-01 merge SHA**.

## Не делать сейчас

Free-text implementation в PR #19, narrator/FactPacket, Codex AgentBackend session, final connection UI, B07 presentation/assets, plugins, auth/public publish, author AI, Florence migration, force dependency upgrade.
