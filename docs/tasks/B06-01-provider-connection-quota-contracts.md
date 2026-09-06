# B06-01 — Provider, connection and quota contracts / T30–31

## Цель

Начать B06 с сетевой и конфигурационной границы Runtime AI, **не подключая свободный текст к gameplay и не добавляя narrator**.

Этот slice должен дать один проверяемый фундамент для следующих B06 частей:

- стабильный `ModelProvider.generate` contract;
- deterministic fake provider для большинства тестов без ключа;
- один bounded OpenAI-compatible Chat Completions adapter;
- OpenRouter preset + custom compatible endpoint;
- connection test без выдуманных capabilities;
- разделение `ProviderPreset` / `Connection` / `ModelProfile`;
- честный `QuotaAdapter` / `QuotaMetric` contract и OpenRouter quota mapping;
- общий deadline/usage/error normalization на provider boundary.

После B06-01 intent parsing, narration и `AgentBackend` остаются отдельными slices.

## Канонический вход

- весь B05 published: merge `002c2cd7c802f06d23f62ac8cde726afef845c24`, main push-CI `34055962204` success;
- `docs/SPECIFICATION.md` §9.2–9.3, §9.7–9.9, §17.2–17.4;
- B06 roadmap: T02/T04/T09/T13–16/T30–31;
- B06-01 закрывает provider/connectivity/quota foundation и целится прежде всего в T30–31.

## Главные invariants

### 1. Inference и agent backend не смешиваются

`ModelProvider` — stateless/bounded inference boundary. Нельзя маскировать будущий `AgentBackend`/Codex session как `/chat/completions`.

B06-01 может определить только минимальные shared capability types, если это нужно для совместимости, но не реализует Codex login/session/chat.

### 2. Секрет не становится данными квеста или публичного клиента

Credential передаётся adapter-у серверной конфигурацией/secret resolver и никогда не входит в:

- `ProviderPreset`;
- export quest;
- Player projection;
- URL/query string;
- normal error/trace body.

UI-facing connection state содержит только безопасную маску/идентификатор и результат проверки.

### 3. Compatible API — документированное подмножество, не обещание «работает со всем»

Первый real adapter поддерживает ограниченный OpenAI-compatible Chat Completions flow. Capabilities определяются проверкой/профилем, а не угадываются по названию модели.

Custom endpoint валидируется до сетевого запроса. Нельзя молча обращаться к metadata/private-network addresses; локальный endpoint разрешается только явной server policy и отдельной проверкой.

### 4. Deadline принадлежит всей operation policy

Provider call принимает абсолютный/оставшийся deadline и прекращает попытку при исчерпании бюджета. Adapter не создаёт собственный бесконечный retry loop.

B06-01 нормализует timeout/cancel/error, но не реализует ещё intent/narrator retry orchestration.

### 5. Usage неизвестен ≠ ноль

Provider response возвращает usage только если он реально известен. Неизвестные token/cost поля остаются `null`/отсутствуют согласно contract.

Не вычислять стоимость из воздуха и не выдавать provider request ID/model ID, если источник их не вернул.

### 6. Quota — набор независимых метрик

`QuotaAdapter.read` возвращает `QuotaMetric[]` с полями:

- `kind`;
- `scope`;
- `unit`;
- `window`;
- `used`;
- `limit`;
- `remaining`;
- `resetsAt`;
- `observedAt`;
- `source`;
- `status`.

Unknown numeric values = `null`. `0` сохраняется как настоящий zero. Ошибка quota endpoint не делает inference connection invalid.

### 7. OpenRouter inference key и management key различаются

Текущий inference key может дать key-level usage/limit через documented key endpoint. Account credits требуют отдельного management credential.

Запрещено:

- использовать management endpoint без отдельного credential;
- подменять management key inference key;
- показывать account balance как доступный, если permission отсутствует;
- выводить точный `resetsAt` только из слова `monthly`.

## Сделать

### A. Package / contracts

Создать bounded Runtime-AI provider package (рабочее имя `@living-history/ai`), не импортирующий Studio/Player.

Минимальные типы:

- `ModelProvider`;
- `GenerateRequest` / `GenerateResult`;
- normalized provider error;
- provider usage;
- `ProviderPreset`;
- `ConnectionConfig` / safe connection view;
- `ModelProfile`;
- `QuotaAdapter` / `QuotaMetric`;
- capability/result types для connection test.

Contracts должны быть immutable/plain-data friendly и не содержать raw credential.

### B. Fake provider

Добавить deterministic scripted fake:

- очередь заранее заданных structured responses/errors;
- фиксируемые model/request IDs/usage;
- call count и captured safe requests для тестов;
- AbortSignal/deadline handling;
- никаких network calls.

Fake нужен как test double и не выдаётся за proof понимания языка.

### C. OpenAI-compatible adapter

Реализовать только нужное documented subset Chat Completions:

- configurable `baseUrl`;
- model profile;
- server-only Bearer credential;
- JSON/structured response mode, если profile заявляет поддержку;
- timeout/AbortSignal;
- bounded input/output limits;
- normalized HTTP/provider errors;
- usage/model/provider request ID, когда они присутствуют;
- без автоматических retries внутри adapter.

Запретить credential в query string и sanitize error bodies.

### D. Provider presets / connection test

Минимум:

- `openrouter` preset с готовым base URL/protocol metadata;
- `compatible` custom preset с явным URL;
- connection test, который проверяет ровно заявленные возможности и возвращает safe status;
- неправильный/неподдерживаемый response format не превращается в fabricated capability.

Не строить финальный Studio connections UI в этом slice; контракт и server-safe service достаточно. UI integration будет отдельным B06/B09 шагом, если не нужен минимальный test harness.

### E. Quota primitives + OpenRouter mapping

Реализовать:

- generic `QuotaAdapter` contract;
- deterministic fake quota adapter;
- key-level OpenRouter quota mapper;
- optional account-credit mapper только при отдельном management credential;
- cache record со `observedAt`, identity/credential revision keying и stale/error states;
- сохранение `null` vs `0`;
- quota failure не меняет inference connection state.

Не делать универсальный «остаток токенов».

### F. Security / endpoint validation

Добавить pure validation для compatible `baseUrl`:

- только `http:`/`https:` по policy;
- credential никогда не вкладывается в URL;
- localhost/private/link-local/metadata ranges запрещены по умолчанию;
- explicit `allowLocal` policy допускает loopback для локальной разработки, но не metadata addresses;
- redirects не должны обходить policy: adapter либо запрещает redirect, либо валидирует конечный target до отправки credential.

### G. Tests / scripts

Добавить `npm run test:ai` либо включить новый package в root verify.

Минимум:

- fake deterministic response/error/abort;
- compatible request shape и structured output handling;
- timeout/deadline normalization;
- secret absent from URL/errors/safe views;
- OpenRouter preset не требует ручного base URL;
- custom endpoint accepted/rejected по policy;
- capability mismatch остаётся ошибкой/unsupported;
- `QuotaMetric` null vs 0;
- inference-key quota отдельно от account credits;
- management endpoint не вызывается без management credential;
- stale/error quota не ломает inference;
- cache identity включает connection/account + credential revision;
- root `npm run verify` green.

## Приёмка B06-01

- есть стабильный provider contract и deterministic fake;
- real compatible adapter покрыт network-mocked tests;
- OpenRouter/custom connection profile проходят T30-level regression;
- quota semantics проходят T31-level regression;
- provider secrets не выходят в public/safe data;
- неизвестные capabilities/usage/quota не выдумываются;
- нет free-text gameplay path, narrator или Codex session implementation в этом PR;
- ADR/STATUS/HANDOFF/worklog синхронизированы после functional gate;
- merge + green main CI публикуют только B06-01, не весь B06.

## Не делать

- intent parsing / clarification / unsupported — B06-02;
- free text → Core execution — B06-02;
- narration strict/expressive / FactPacket / template fallback — B06-03;
- Codex `AgentBackend` implementation/login/session — B06-04/B10 boundary;
- full Studio connection catalog UI polish;
- Player presentation B07;
- plugins B08;
- public auth/publish B09;
- authoring AI/autoconstructor B10;
- Florence migration B11;
- automatic paid API fallback from ChatGPT/Codex subscription.

## Следующий slice

B06-02 — free-text intent boundary: prepared interpreter responses + deterministic intent parser contract, `needs_clarification` / `unsupported`, negation/hypothetical/multi-action protection and route confirmed `ResolvedIntent` through the same existing Core resolver as explicit actions.