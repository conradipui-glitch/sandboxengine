# Передача работы

Обновлено: 2026-09-07

Текущий блок: **B06-02 — Free-text intent boundary / T02 T04 T09 T16**  
База: published B06-01 merge `a08f3434060abe699be5d431464597645557b8f9`  
B06-01 push-CI main: `34056977026` — success  
Ветка: `b06-02-free-text-intent-boundary`  
PR: #20  
Статус: **functional gate `34057719194` success; docs sync → final current-head CI → merge/main publication gate**

## Что уже published

B01–B05 и B06-01 published.

Published B06-01 merge: `a08f3434060abe699be5d431464597645557b8f9`.  
Main CI: `34056977026` — success.

B06-01 даёт provider/connection/quota foundation: deterministic fake, OpenAI-compatible adapter, OpenRouter/custom preset, safe credentials/endpoints, capability check, bounded deadline/errors/usage и honest quota semantics.

## Что реализовано в B06-02

### Strict intent boundary

`@living-history/ai` теперь разделяет:

- `resolved`;
- `needs_clarification`;
- `unsupported`;
- `failed`.

Model output — proposal, не gameplay authority. Engine сам строит `ResolvedIntent` после exact validation и сам пришивает исходный `sourceInput.text`.

Запрещены extra authority fields: statePatch/effects/resource delta/duration/calculated outcome/code. Unknown action, invalid args и unknown entity IDs не проходят catalog/allowlist boundary.

Interpreter имеет общий максимум 2 attempts с одним absolute deadline. Repair входит в эти 2 attempts.

### Один causal resolver

Legacy explicit HTTP request сохранён для B04/B05 compatibility.

Free-text использует новый `input.kind=text`, но после validation оба пути сходятся в один action-service helper, который вызывает тот же Core `resolvePaintAction` и canonical time planning.

Server/interpreter не считают authored resource cost или duration.

### Idempotency before AI

Text request hash строится по исходному input до provider call. `claimOperation` происходит до interpreter.

Поэтому повтор того же idempotency key:

- возвращает stored response;
- не вызывает provider снова;
- не запускает Core снова.

### Processing outcomes без turn

Clarification/unsupported/failed сохраняются через `finishWithoutTurn`.

Revision, clock, resources и WorldState остаются неизменными. Public processing response не маскируется под `action.status`.

### Clarification binding

Clarification ссылается на persisted no-turn operation и revision. Перед provider/Core follow-up проверяются session-bound operation, kind и revision. Stale/forged reference отклоняется конфликтом.

Это structural safety contract, не полноценная dialogue memory. Качество живого русского понимания fake-provider regressions не доказывают.

### Frozen binding

Player runtime template получает intent catalog вместе с exact frozen release/state, а executor остаётся bound к frozen authored action definition. Изменение draft не переключает уже запущенную frozen версию.

ADR: `docs/decisions/0019-free-text-intent-shares-core-resolver.md`.

## CI evidence

- `414be66c6d7f471e1b37fe649f4aff0b42d01c16`: strict interpreter/validator + T02/T04/T09/T16 corpus;
- `6761c2df54f9e1e5f3760a2ad1c05790850b0b52`: first Runtime integration; CI `34057574708` дошёл до server tests и выявил 5 локальных regressions;
- причины: explicit wrapper compatibility и optional clarification key parser; AI 19/19, storage/control уже были green;
- `9d21c3d7bc8c5b43f4caa32bbbc6438a4c0cc361`: compatibility/parser corrections;
- `8e530be6232ce7cc2c0ed3c198eb84f6b44ba71e`: frozen intent-catalog binding;
- PR CI `34057719194` — **success**, полный `npm run verify`.

## Acceptance state

Закрыто функционально:

- free-text proposal → strict validated `ResolvedIntent`;
- same Core resolver as explicit action;
- claim-before-AI idempotency;
- clarification/unsupported/failed no-turn semantics;
- unchanged revision/time/resources on processing outcomes;
- stale/forged clarification rejection before provider/Core;
- T02/T04/T09/T16 prepared regressions;
- malformed/injection proposals fail closed after bounded attempts;
- old B04/B05/T15 behavior green;
- frozen runtime/catalog binding green;
- root `npm run verify` green.

Остался Publication Gate:

1. final current-head PR CI после docs sync;
2. mark PR #20 ready;
3. merge с expected head SHA;
4. verify push-to-main CI on exact merge SHA;
5. только после green main объявить B06-02 published.

## Следующее после публикации B06-02

**B06-03 — narrator/fallback pipeline**:

- Core-derived `FactPacket`;
- strict + expressive narrative profiles;
- narrator cannot add mechanics/player decisions/secret speakers;
- deterministic local template fallback;
- bounded narrator retry;
- combined intent+narrator absolute deadline/failure semantics;
- T13/T14-oriented regressions.

Создать B06-03 отдельной bounded task-card/веткой **точно от verified B06-02 merge SHA**.

## Не делать сейчас

Narrator/B06-03 implementation в PR #20, final Studio connection UI, Codex/AgentBackend session, B07 presentation/assets, plugins, auth/public publish, author AI, Florence migration, long-term dialogue/RAG memory или force dependency upgrade.
