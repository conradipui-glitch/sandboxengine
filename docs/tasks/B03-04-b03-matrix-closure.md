# B03-04 — closure of T05/T06/T08 and replay hash

## Цель

Закрыть **только** конкретные пробелы, найденные после B03-03 при сверке с каноническим B03. После этого общий B03 должен либо пройти T05/T06/T08 и быть принят, либо остаться открытым с одним новым явно доказанным gap. Не добавлять B04 runtime/storage.

## Вход

- B03-01: static integer-time planning, inclusive `[start,end]`, deterministic order, event limit;
- B03-02: chronological typed effects, whole-transition atomicity, clock/revision commit;
- B03-03: tasks/deadlines/terminal interruption, explicit functional RNG;
- canonical B03/T05–06/T08 из `docs/SPECIFICATION.md`.

## Сделать

### 1. Entity movement effect для T05

Добавить отдельный strict typed GameplayEffect `entity.move` (или эквивалентный минимальный namespaced Core effect), который:

- принимает existing `entityId` и existing destination `locationId`;
- не создаёт entity/location;
- переносит entity на trial state через тот же all-or-nothing `tryApplyEffectBatch`;
- не допускает двух location одновременно;
- missing entity/location → explicit effect failure без partial state.

Не добавлять generic `setPath`/arbitrary state mutation.

### 2. Dynamic scheduler processing + generated-event budget

Добавить чистый Core processor поверх существующих contracts, который может обработать child events, возвращённые доверенным deterministic event handler/resolver, **без storage/plugin system**.

Требования:

- initial events получают deterministic processing sequence после canonical sort;
- generated child event не может попасть в прошлое;
- child at same time получает effective order/priority не раньше parent и новый monotonic sequence;
- обработка всегда chronological;
- один общий bounded `maxSteps/maxEvents` на transition, включая generated children;
- limit overflow → explicit failure без candidate state;
- duplicate/unsafe/generated-invalid event → failure без partial state;
- terminal прекращает processing и оставляет later events unprocessed;
- существующий `planTimeAdvance` и его B03-01 semantics не ломаются.

Не вводить universal hook bus. Нужен один typed scheduler-handler boundary, который позже сможет использовать B08 plugin registry.

### 3. Exact T05 regression

Сценарий:

- NPC находится не в мастерской;
- task completion scheduled at 900 sec переносит NPC в workshop через typed effect;
- player long work/wait interval идёт до 2400 sec;
- последующее event/step после 900 проверяет authoritative trial state и видит NPC уже в workshop;
- return происходит на 900, не после 2400;
- final trace/order детерминирован.

### 4. Exact T06 regression

Сценарий должен одновременно доказать:

- task completion и deadline имеют один timestamp;
- deterministic order объявлен явно так, что completion применяется **до** terminal evaluation;
- clock проходит границу суток только арифметикой integer elapsed seconds (например 86_300 → 86_500);
- same input даёт один и тот же final state/terminal result;
- никакой `Date`/timezone logic в Core нет.

### 5. Exact T08 regression

Доверенный test handler для immediate event детерминированно порождает child event в тот же timestamp и мог бы продолжать бесконечно.

Проверка:

- общий step budget срабатывает;
- ошибка понятная (`step_limit_exceeded` или эквивалент);
- все trial effects предыдущих generated steps отбрасываются;
- authoritative input state/clock/revision неизменны;
- long wait не меняет этот результат и не превращает loop в partial commit.

### 6. Replay/hash

Добавить deterministic Core helper для replay fingerprint/hash минимум из:

- canonical initial state / expected revision;
- resolved scheduler plan/ordered processed events;
- RNG seed/stream/cursor or draw provenance;
- final candidate state / terminal marker.

Одинаковый plan+seed+versions → одинаковые ordered effects и hash. Изменение meaningful input/seed/result → другой hash.

Использовать уже принятую canonical serialization/cryptographic hash практику проекта; не вводить второй несовместимый canonicalizer.

## Приёмка

- clean `npm ci` + `npm run verify`;
- exact T05, T06, T08 существуют как именованные Core regressions и passed;
- `entity.move` проходит contract + atomic effect tests;
- dynamic generated-event budget не меняет B03-01 static planner contract;
- same-time child ordering имеет deterministic sequence semantics;
- same plan+seed replay даёт одинаковые effects/hash;
- `Date`, `Math.random`, timers, HTTP/storage/LLM отсутствуют в Core/contracts;
- `check:boundaries` и `docs:check` зелёные.

## Не делать

SQLite/Memory persistence, Runtime API, operation leases/idempotency, recurring background workers, real-time simulation, generic plugin manager, NPC AI, Studio/Player.

## После приёмки

Снова сверить B03 с canonical card. Если T05/T06/T08 и replay/hash закрыты — принять **общий B03**, обновить STATUS/HANDOFF и начать B04 от чистого `main`. Не открывать B04 до этой проверки.
