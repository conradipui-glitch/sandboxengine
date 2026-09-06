# B04-03 — Runtime HTTP, guest ownership и player-safe projection

## Цель

Завершить общий B04 минимальным публичным Runtime API поверх уже принятых B04-01/B04-02 semantics. HTTP не пересчитывает игровую причинность и не даёт клиенту прямой доступ к `WorldState`, fencing token, lease или внутренним operation rows.

## Вход

- B03 Core accepted/published;
- B04-01 `RuntimeStorage` + idempotency/lease/fencing semantics, ADR 0011;
- B04-02 durable `SQLiteRuntimeStorage`, restart/fault T10–12, ADR 0012;
- `docs/SPECIFICATION.md` §8 и публичная граница Player/Runtime;
- существующие `SceneFrame` / `PresentationPlan` contracts.

## Главный invariant

**Transport принимает/возвращает только публичные команды и player-safe данные.**

HTTP-код не имеет права:

- менять `WorldState` напрямую;
- обходить `claimOperation` / fencing / `commitTurn`;
- показывать клиенту authoritative/private state целиком;
- возвращать service lease timestamps, fencing tokens или внутренний operation lifecycle как игровую механику;
- запускать Core повторно из-за HTTP retry.

## Сделать

### 1. Минимальный server package

Превратить `apps/server` из README-заглушки в запускаемый Node server package с dependency injection для storage/runtime services.

Обязательные public endpoints этого slice:

- `GET /v1/health` — версия/готовность без секретов;
- `POST /v1/sessions` — создать гостевую игровую сессию из явно разрешённого seed/release fixture этого выпуска;
- `GET /v1/sessions/:sessionId` — получить текущий `PlayerView` только владельцу сессии;
- `POST /v1/sessions/:sessionId/actions` — принять bounded explicit action request с `Idempotency-Key` и `expectedRevision`;
- `GET /v1/sessions/:sessionId/operations/:operationId` — восстановить публичный status/result для того же владельца.

Не публиковать Control/Studio endpoints.

### 2. Guest ownership

Создание сессии выдаёт один opaque guest credential. Сервер хранит только verifier/hash либо эквивалентный server-side secret material; credential не попадает в `WorldState`, TurnRecord, logs или public projection.

Все session/operation reads и writes проверяют ownership **до** раскрытия данных. Чужой/неверный credential не должен подтверждать существование приватной session подробным различающим ответом.

В тестах должны быть как минимум два guest owner и попытка cross-session доступа.

### 3. PlayerView

Добавить отдельную публичную projection function/type. Она строится из разрешённых данных server-side и не является alias/cast `WorldState`.

Минимально допустимо показать:

- `sessionId`;
- pinned public release identity без внутренних storage полей;
- current revision;
- игровой clock/terminal outcome, если они разрешены игроку;
- только явно разрешённые entity/resource/item/scene поля;
- текущий `SceneFrame`, если он уже существует для fixture;
- last public action response / presentation metadata, если сохранены как public response.

Не показывать:

- hidden knowledge/future events/internal queues;
- service clock, lease expiry, fencing counter/token;
- request hash;
- internal active operation id без необходимости восстановления;
- DB schema/internal errors/stack traces;
- secrets/provider configuration.

Для текущего минимального fixture, где полноценный visibility model ещё не реализован, использовать **deny-by-default projection**: только явно перечисленные safe fields. Не делать `return session.state`.

### 4. Action request и idempotency transport

`POST .../actions` принимает только bounded explicit action, которую текущий Core действительно умеет обработать без B06 LLM. Свободный текст в B04-03 не добавлять.

Transport обязан:

1. authenticate guest;
2. validate body/size/content type;
3. canonicalize request и вычислить SHA-256 server-side;
4. вызвать `claimOperation` с `Idempotency-Key` + expected revision;
5. map existing domain outcome, не дублируя storage semantics;
6. для acquired operation выполнить ровно один поддержанный deterministic Core path;
7. сформировать player-safe public response;
8. commit через storage;
9. вернуть **сохранённый** public response.

Same key/same request after lost HTTP response должен вернуть persisted response без второго Core execution.

### 5. Domain outcome → HTTP mapping

Минимальная policy:

- new committed result → `200`;
- completed replay → `200` с тем же public payload;
- same request still processing → `202` + public operation id/status + bounded polling hint;
- idempotency key reused → `409` code `IDEMPOTENCY_KEY_REUSED`;
- another action in progress → `409` code `ACTION_IN_PROGRESS`;
- revision conflict → `409` code `REVISION_CONFLICT` + current public revision;
- invalid request → `400`;
- unauthenticated/not-owned session → uniform `404` или policy-equivalent non-disclosing response;
- storage busy/unavailable → `503`, без повторного Core execution и без success claim.

HTTP mapping должна быть отдельной transport function, а не зашита в `RuntimeStorage` result unions.

### 6. Operation recovery

Public operation status endpoint не выдаёт lease/fencing internals. Минимальные состояния: `processing`, `completed`, `finished_without_turn` и public response, если он уже зафиксирован.

Expired processing operation не должна выглядеть вечной. Повтор исходного action request с тем же idempotency key остаётся canonical recovery path.

### 7. T15 / public boundary regression

Добавить T15 как сквозной public API test минимум для двух историй:

1. **player-safe projection:** создать guest session → GET session → убедиться, что public JSON не содержит storage/private fields и соответствует allowlist;
2. **retry/recovery:** отправить action → получить success → повторить идентичный request/key → получить byte-equivalent persisted public action payload, revision не растёт второй раз.

Дополнительные обязательные API regressions:

- different body under same key → 409 reuse;
- wrong expected revision → 409 without Core execution;
- concurrent/different action while operation active → 409;
- guest B cannot read or mutate guest A session;
- malformed body/oversize/unsupported content type → no operation/state change;
- operation status never leaks fencing/lease/requestHash;
- reload GET returns latest committed PlayerView without replaying presentation/gameplay.

### 8. Canonical B04 audit

После зелёного B04-03 повторно подтвердить на одном PR/main state:

- T10 durable idempotent replay;
- T11 single ownership / no lost update;
- T12 crash/restart/fencing;
- T15 public API/player-safe projection;
- Core boundaries still clean;
- no LLM/Studio/Florence migration in B04.

Только после этого общий **B04** можно объявить accepted/published.

## Приёмка

- `npm ci` + `npm run verify`;
- отдельные server/API tests входят в обязательный verify;
- public projection deny-by-default и имеет regression на отсутствие private fields;
- guest ownership проверяется server-side;
- exact idempotent retry возвращает сохранённый response;
- HTTP retry не повторяет Core после completed operation;
- server restart с SQLite сохраняет session/result ownership/recovery в пределах реализованной guest policy;
- HTTP не меняет B04-01/B04-02 storage result unions ради status codes;
- docs/OpenAPI capability registry рекламируют только реально работающие endpoints;
- общий B04 закрывается только после финального T10–12/T15 audit и push-CI main.

## Не делать

- свободный text intent / narrator / provider API (B06);
- Studio/Control API и роли редакторов (B05/B09+);
- Florence migration (B11);
- WebSocket/Redis/queues/background realtime;
- публичную регистрацию аккаунтов;
- универсальную auth-platform;
- generic plugin middleware;
- raw `WorldState` endpoint;
- произвольный debug state mutation endpoint.
