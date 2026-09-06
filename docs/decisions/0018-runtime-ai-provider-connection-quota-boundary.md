# ADR 0018 — Runtime AI provider, connection и quota boundary

Дата: 2026-09-07  
Статус: accepted в B06-01 после T30/T31 functional gate

## Контекст

После публикации B05 движок имеет deterministic author→frozen→Player→Runtime/Core путь, но ещё не имеет безопасной границы для внешнего model inference. B06 должен добавить free text и narration, не превращая сетевой adapter в источник gameplay truth и не смешивая обычный inference с будущим session-oriented `AgentBackend`.

Первый bounded slice B06-01 закрывает только foundation для T30–31: provider/connection contracts, OpenAI-compatible adapter, connection capability check и honest quota reporting.

## Решение

### 1. `ModelProvider` — bounded stateless inference boundary

Новый `@living-history/ai` определяет `ModelProvider.generate` с явными:

- model/messages;
- optional task/schema context;
- response format;
- output limit;
- absolute deadline / AbortSignal;
- normalized success/error;
- optional provider usage/model/request IDs.

Adapter не делает внутренний retry loop. Retry/fallback budget принадлежит будущему B06 orchestration layer.

`AgentBackend`/Codex login-session-chat не маскируется под `/chat/completions` и остаётся отдельным контрактом будущего slice.

### 2. `ProviderPreset`, `Connection` и `ModelProfile` разделены

`ProviderPreset` описывает protocol/default base URL. `ConnectionConfig` связывает preset, endpoint policy и secret reference/revision. `ModelProfile` выбирает model + response format/output limit.

Raw credential не входит в safe connection view, quest/export или browser URL. Adapter получает credential отдельно на server boundary и отправляет его только в Authorization header.

OpenRouter preset фиксирует `https://openrouter.ai/api/v1`; compatible preset требует явный base URL.

### 3. Первый real adapter поддерживает только documented compatible subset

`OpenAiCompatibleModelProvider` реализует bounded Chat Completions subset:

- POST `chat/completions`;
- text / JSON-object response mode согласно profile capability;
- max output tokens;
- absolute deadline/cancellation;
- normalized HTTP/network/invalid-response errors;
- provider usage/model/request ID только когда они реально присутствуют;
- no retries;
- redirects запрещены.

JSON-object mode доказывает только syntactic object response. Semantic validation против intent/narrator schema относится к B06-02/B06-03 consumer layer.

### 4. Capabilities не угадываются по имени модели

Connection test вызывает provider с тем response format, который заявляет `ModelProfile`, и принимает capability только если фактический result соответствует форме. `capability_mismatch` остаётся отдельным результатом; unknown/failed capability не превращается в success.

### 5. Endpoint policy fail-closed на статически известные опасные targets

Base URL должен быть absolute HTTP(S), без username/password/query/fragment. HTTPS требуется по умолчанию; HTTP разрешён только для explicit loopback development policy.

Literal loopback/private/link-local/metadata/reserved targets блокируются по умолчанию; metadata hostnames блокируются; redirects запрещены, поэтому credential не следует за HTTP redirect.

Это **syntactic target policy**, а не доказательство DNS-aware SSRF isolation: production transport/deployment обязан дополнительно ограничивать egress/DNS resolution. B06-01 не утверждает защиту от DNS rebinding только силами `URL` parser.

### 6. Credentials opaque, но header-safe

API key не интерпретируется как URL. Символы вроде `?`, `&`, `#` допустимы внутри opaque credential, потому что credential не конкатенируется в URL. CR/LF запрещены как header-unsafe input.

Normalized provider errors не включают raw response body, поэтому secret/provider diagnostic не протекают через стандартный error result.

### 7. Usage и quota не выдумываются

Unknown token/usage values = `null`, а не `0`.

`QuotaAdapter.read` возвращает независимые `QuotaMetric[]` с kind/scope/unit/window/used/limit/remaining/resetsAt/observedAt/source/status. Real zero сохраняется как `0`; unknown numeric fields остаются `null`.

Quota failure не меняет inference connection state.

### 8. OpenRouter inference quota и account credits разделены

Key-level `/key` читается inference credential. Account `/credits` вызывается только если отдельно предоставлен management credential; иначе возвращается `permission_required` без fabricated balance и без второго network call.

`limit_reset: "monthly"` остаётся period без выдуманного exact reset. Если provider реально возвращает ISO timestamp, он сохраняется как `resetsAt`.

Quota cache identity включает connection/account/credential revision. Expired cached `available` metric становится `stale`, а не незаметно выдаётся свежим.

## Доказательство

`test:ai` и root `npm run verify` закрепляют:

- deterministic fake provider;
- OpenRouter preset и custom compatible URL;
- safe connection view без raw credential;
- real request shape / redirect policy / header-only credential;
- capability mismatch;
- deadline/error/usage normalization;
- null vs 0 quota semantics;
- inference vs management credentials;
- explicit reset timestamp vs period-only reset;
- quota error independence;
- cache identity/stale state;
- package boundary без Core/Runtime/Control/Player/apps/fs/env imports.

Functional hardened head `64c644eee9e9bf66c199b082d12efedf25c9fa7f` прошёл CI `34056571152` — success.

## Не решено этим ADR

- free-text intent/clarification/unsupported/resolver — B06-02;
- narrator/FactPacket/template fallback — B06-03;
- `AgentBackend`/Codex compatibility + final B06 audit — B06-04;
- final Studio connection-management UX;
- B07 presentation/assets;
- B08 plugins;
- B09 auth/public publish;
- B10 author AI;
- B11 Florence migration.
