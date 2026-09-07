# ADR 0020 — Narrator получает FactPacket после Core и входит в один commit

Дата: 2026-09-07  
Статус: accepted в B06-03 после functional gate

## Контекст

B06-02 опубликовал безопасную границу понимания свободного текста: validated text и explicit action сходятся в один `ResolvedIntent`/Core resolver. Следующий риск — добавить LLM-narrator так, чтобы красивый текст незаметно стал вторым источником gameplay truth, получил полный `WorldState`, мог переписать рассчитанный результат или превратить отказ narrator в rollback уже рассчитанного хода.

B06-03 решает только presentation stage после Core: narrator оформляет уже рассчитанные факты, а structured `action` и `playerView` остаются каноническими для механики и UI.

## Решение

### 1. Narrator вызывается только после Core calculation

Порядок calculated turn:

1. claim operation;
2. optional free-text intent → validated `ResolvedIntent`;
3. Core рассчитывает candidate state/action result;
4. Runtime строит bounded `FactPacket`;
5. narrator пытается оформить текст или выбирается deterministic fallback;
6. Runtime строит один public response;
7. выполняется один `commitTurn`.

Narrator никогда не вызывает Core и не может потребовать повторный gameplay calculation.

### 2. `FactPacket` — отдельная минимальная граница вместо `WorldState`

Narrator получает versioned serializable packet с уже рассчитанными:

- action type/status;
- requested/completed units;
- duration/reason;
- before/after public clock;
- изменившимися public resource values/units;
- bounded allowed speaker IDs;
- bounded observation allowlist.

В packet не передаются полный `WorldState`, resource min/max, items, content hash, storage/fencing/idempotency metadata, executable effects или mutation instructions.

`FactPacket` формируется Runtime из trusted structured execution, а не моделью.

### 3. Strict и expressive имеют одинаковые права

Профили `strict` и `expressive` меняют только style instructions/output budget. Они используют один `FactPacket`, один validator и одни speaker/observation allowlists.

Expressive profile не получает дополнительных facts/entities/effects и не считается доказательством отсутствия всех смысловых hallucinations.

### 4. Narrative output — bounded presentation proposal

Model narrator возвращает exact structure:

- `summary`;
- `dialogue[{speakerId,text}]`;
- `observationRefs[]`.

Validator отклоняет extra keys, unknown speaker/observation IDs, hidden refs, empty/oversized text и authority fields вроде `statePatch`, `effects`, `action`, duration/resource mutation или asset injection.

Невалидный model output не исправляет world и не становится gameplay result.

### 5. Fallback детерминирован и локален

Для `executed`, `partial` и `blocked` существует local renderer, который из одного `FactPacket` детерминированно объясняет фактически выполненное, причину и duration.

Narrator timeout/network error/invalid JSON/invalid structure после bounded attempts даёт template fallback. Fallback не вызывает другую модель и не запускает Core повторно.

### 6. Один absolute AI deadline на operation

После successful operation claim Runtime создаёт один absolute deadline (максимум 25 секунд по текущей policy).

Для free-text turn тот же timestamp передаётся последовательно:

- intent interpreter;
- narrator.

Narrator использует только оставшееся время. Explicit action bypasses intent, но narrator всё равно работает в том же operation deadline policy.

Provider adapters по-прежнему не имеют собственного бесконечного retry loop; narrator имеет максимум две attempts, включая repair.

### 7. Narrator failure после Core не отменяет ход

Если Core уже успешно рассчитал candidate state, отказ narrator никогда не превращается в `ACTION_EXECUTION_FAILED` и не откатывает рассчитанный action.

Runtime ловит narrator failure, строит local fallback и делает один `commitTurn` с тем же candidate state.

### 8. Narrative сохраняется вместе с committed public response

`action`, `playerView` и optional `narrative` сохраняются одним operation response до завершения commit.

Idempotent replay возвращает этот persisted payload byte-equivalent и не вызывает повторно intent provider, narrator или Core.

Public narrative содержит только presentation fields `profile/source/summary/dialogue/observationRefs`. Usage/model/provider request IDs и narrator attempt evidence наружу не публикуются.

### 9. Backward compatibility сохраняется

Narrator остаётся optional Runtime dependency. Если он не настроен, существующий action response не получает новое поле и B04/B05/B06-02 consumers продолжают работать.

Player client принимает optional narrative; gameplay цифры/остатки/время по-прежнему читает из structured `action`/`playerView`. Narrative text только отображается и не используется для client-side simulation.

## Доказательство

AI tests фиксируют:

- deterministic fallback для executed/partial/blocked;
- strict/expressive одинаковую authority boundary;
- unknown speaker/observation и authority fields → rejection/fallback;
- максимум 2 narrator attempts;
- expired deadline → fallback без provider call.

Runtime tests фиксируют:

- broken narrator → fallback + один committed turn;
- retry возвращает persisted narrative без новых narrator/Core calls;
- valid narrator не меняет canonical action/time/resource result и не запускает Core второй раз;
- intent и narrator получают один и тот же absolute deadline;
- narrator prompt не содержит resource min/max, item, contentHash, fencing/requestHash metadata;
- public response не содержит narrator evidence/provider diagnostics.

Player tests фиксируют backward compatibility без narrator и bounded optional narrative surface.

Functional hardening head `12894d63bf64e290a854249438ec9f7c555177e1` прошёл полный PR CI `34080825132` — success (`npm run verify`).

## Не решено этим ADR

- доказательство качества живой модели на русском и richer expressive prose — bounded live eval/manual playtest;
- semantic long-term dialogue/RAG memory;
- `AgentBackend`/Codex login/session/rate-limit compatibility;
- canonical B06 audit — всё это B06-04;
- final Studio connection UI;
- B07 presentation/assets/animations/audio;
- B08 plugins, B09 auth/public publish, B10 author helper, B11 Florence migration.
