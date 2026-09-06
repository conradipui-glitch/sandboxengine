# ADR 0019 — Free-text intent делит один Core resolver с explicit action

Дата: 2026-09-07  
Статус: accepted в B06-02 после functional gate

## Контекст

B06-01 опубликовал provider/connection/quota foundation, но модель ещё не имела права интерпретировать игровой текст. Главный риск B06-02 — случайно создать второй gameplay-контур, где LLM не только понимает формулировку, но и сама определяет стоимость, время, effects или состояние мира.

Канонический контракт требует обратного: свободный текст и готовое действие после понимания должны сходиться к одному `ResolvedIntent` и одному Core resolver. `needs_clarification`, `unsupported` и технический `failed` не являются игровыми исходами и не изменяют мир.

## Решение

### 1. Model proposal не является gameplay authority

`@living-history/ai` вводит `IntentDecision`:

- `resolved`;
- `needs_clarification`;
- `unsupported`;
- `failed`.

Модель возвращает только bounded proposal. `ResolvedIntent` строится Engine после строгой проверки proposal; исходный `sourceInput` берётся из реального пользовательского текста и не доверяется модели.

Для `resolved` принимаются только exact fields `actionType`, participant/target IDs, args и normalized description. Неизвестный action type, лишний arg, неизвестный entity ID или дополнительное поле отклоняют proposal.

`statePatch`, effects, resource delta, duration, calculated outcome, code и другие authority fields не проходят exact-shape validation.

### 2. Action catalog — allowlist, а не подсказка

Interpreter получает поддерживаемый action catalog текущего runtime template/release со схемой аргументов. Action должен существовать в catalog, args должны пройти schema, participant/target IDs — публичные allowlists.

Временно blocked известная механика не должна исчезать из catalog только из-за precondition: иначе понимание ошибочно превратит `blocked` в `unsupported`. Фактические preconditions и результат всё равно пересчитывает Core по авторитетному state.

### 3. Explicit и text сходятся до Core calculation

Существующий explicit `core.paint` сохраняет старый HTTP/request-hash contract и внешний executor API. Внутри action-service explicit command преобразуется в `ResolvedIntent`.

Validated text уже приходит как `ResolvedIntent`.

Оба пути используют общий `executePaintResolvedIntent`, который вызывает тот же `resolvePaintAction`, затем canonical time planning/application. Ни server glue, ни interpreter не считают resource cost, duration или effects.

Это сохраняет B04/B05 compatibility и одновременно исключает отдельный `FreeTextPaintExecutor`.

### 4. Operation claim происходит до AI

Request hash для text строится по исходному input до provider call. `claimOperation` выполняется перед interpreter.

Следствия:

- idempotent replay возвращает persisted response;
- повтор не спрашивает модель второй раз;
- повтор не запускает Core второй раз;
- тот же idempotency key с другим исходным текстом остаётся конфликтом существующего storage contract.

### 5. Processing outcomes завершаются без turn

`needs_clarification`, `unsupported` и intent `failed` сохраняются через `finishWithoutTurn`.

Для них неизменны:

- WorldState;
- revision;
- game clock;
- resources;
- turn history.

Public response явно остаётся processing result, без `action.status`.

### 6. Clarification привязана к сохранённой operation и revision

Clarification ID ссылается на конкретную persisted no-turn operation. Follow-up до provider/Core проверяет:

- та же session;
- operation действительно завершилась `needs_clarification`;
- reference revision совпадает с expected/current revision.

Stale или forged reference даёт conflict до AI/Core execution.

B06-02 фиксирует только этот безопасный bounded reference contract. Полноценная semantic dialogue/context orchestration не объявляется готовой: fake follow-up доказывает границы/идемпотентность, но не качество понимания живой русской моделью.

### 7. Право игрока сохраняется на interpreter boundary

Prepared T02/T04 corpus закрепляет, что:

- «Не подписываю» не становится подписью;
- «Что будет, если подпишу?» остаётся вопросом;
- цитата чужого решения не становится решением игрока;
- просьба, разрешение и предположение о будущем согласии другого персонажа не смешиваются.

Если соответствующей механики нет в authored catalog, нельзя подставить ближайший `core.paint` ради продолжения.

### 8. Multi-action и injection fail closed

«Сначала X, затем Y» даёт clarification, не скрытое исполнение X.

Prompt injection считается пользовательскими данными. Proposal с неизвестным privileged action/state mutation отклоняется. Format repair имеет общий максимум две provider attempts; после лимита — `failed` без turn.

### 9. Frozen runtime получает catalog рядом с frozen action definition

Player bootstrap передаёт intent catalog в runtime template вместе с конкретным frozen release/state и executor, bound к frozen authored action definition. Изменение draft не переключает catalog уже запущенной frozen версии.

## Доказательство

`test:ai` закрепляет exact decision shapes, catalog/args/entity allowlists, bounded repair, T02/T04/T09/T16 и отсутствие authority fields.

`apps/server/test/runtime-intent.test.mjs` доказывает:

- free text и legacy explicit дают одинаковый Core-calculated result;
- claim-before-AI replay не повторяет provider/Core;
- clarification/unsupported/failed не меняют world;
- stale/forged clarification отсекается до provider/Core;
- privileged malformed proposal после bounded attempts не создаёт turn.

Первый integration CI `34057574708` выявил два реальных compatibility-шва: explicit wrapper был случайно переведён на новый `executeIntent`, а optional clarification parser неверно сравнивал sorted keys. Оба исправлены без изменения архитектурного решения.

Functional head `8e530be6232ce7cc2c0ed3c198eb84f6b44ba71e` прошёл полный PR CI `34057719194` — success (`npm run verify`).

## Не решено этим ADR

- доказательство качества живого русского intent model — отдельный bounded `eval:ai`/live eval;
- полноценный semantic dialogue memory/context orchestration;
- narrator, `FactPacket`, strict/expressive profiles и template fallback — B06-03;
- общий intent+narrator deadline/failure pipeline — B06-03;
- `AgentBackend`/Codex compatibility и final B06 audit — B06-04;
- final Studio connection UI;
- B07 presentation/assets, B08 plugins, B09 auth/publish, B10 author helper, B11 Florence migration.
