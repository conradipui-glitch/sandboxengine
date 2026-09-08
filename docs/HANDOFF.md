# Передача работы

Обновлено: 2026-09-08

Текущий блок: **B11 — реальные квесты и интеграция**  
База: published B10 merge `4e5fea2888d14440c60ad48abffbefe42abfe637`  
Ветка Engine: `b11-real-quests-integration` / PR #35  
Companion integration: `conradipui-glitch/sandbox` branch `b11-engine-runtime-routing` / PR #10  
Статус: **реализация B11 завершена; остаётся exact-head publication gate**

## Что уже опубликовано

B01–B10 опубликованы. B10 закрыл author-assistant boundary, account/login/quota isolation и regression:

`author request → linked blocks → Apply → correction → Apply → validation → frozen playtest`.

B10 merge: `4e5fea2888d14440c60ad48abffbefe42abfe637`; exact main CI #650 / `34209005817` — success.

## Frozen source baseline B11

Florence мигрируется только из exact source:

- repo `conradipui-glitch/sandbox`;
- merge PR #9;
- SHA `092bcef0be5943e32bf02f08f9e9d4cde393fa95`;
- source production workflow #47 / run `34012448412` — install/tests/build/deploy success.

Old live sessions are not converted. Existing `HistorySession` / `StoredGame` data remains on legacy runtime unless a session was explicitly created with an Engine route binding.

## B11 architecture contract — сохранять

- **No Florence-specific branch in `packages/core`.**
- Quest-specific actors/facts/resources remain authored data.
- Six Florence source decisions are narrative beats, not a generic turn or clock rule.
- Free text may be interpreted by AI; Runtime/Core owns validation and mutation.
- `executed`, `conditional` and `blocked` remain distinct semantics.
- Blocked/no-turn paths do not advance revision/clock or partially mutate state.
- Prepared client options are explicit authored actions, not text that AI must rediscover.
- Browser presentation never becomes gameplay authority and performs no authoritative arithmetic.
- Published release identity and session/runtime binding remain immutable for an in-progress session.
- Rollback affects only future session assignment.

## Реальные квесты B11

### `examples/florence`

Полный six-beat authored quest. Generic conditions/cases preserve source-dependent outcomes including:

- canonical `draft → ledger → counter → pigment → public → deliver` → `Незавершённое принято`;
- paid compromise `healer → team → advance → testimony → share-ledger → deliver` → `Чужое имя над вашей работой`;
- refusal/authorship `close → refuse → protect → testimony → rest → sign` → `Имя без заказчика`;
- unsupported/weak negotiation stays conditional until generic state conditions justify execution;
- withdrawal does not conjure money that was never received.

### `examples/transfer-desk`

Отдельный three-beat quest with social request/response, item possession and resource pressure. It proves the Engine path is not Florence-shaped special casing.

## Runtime и HTTP path

The Engine authored Runtime now:

- creates sessions from the current published release;
- pins release identity to the session;
- exposes safe `PlayerView + situation` projections;
- accepts explicit `authored.option` actions;
- routes free text through the current-beat intent catalog;
- commits authoritative state only in Runtime storage;
- returns idempotent replay for the same operation key;
- preserves blocked/no-turn state without fake success.

## `sandbox` BFF integration

PR #10 adds the production-facing compatibility boundary without rewriting the legacy Durable Object:

- `ENGINE_FLORENCE_ROLLOUT=off|test|on` is evaluated only for **new** Florence sessions;
- `RuntimeRouteSession` stores upstream Engine session identity and credential;
- an Engine-bound session stays on Engine after rollout is switched back to `off`;
- an id without Engine binding continues through legacy `HistorySession` unchanged;
- prepared UI choices are forwarded as explicit `authored.option` + `optionId`;
- freeform text remains a text intent request;
- Engine `PlayerView + situation` is adapted server-side to the existing `GameState` shape, so the current React client receives authored options without calculating gameplay.

The latest client/BFF exact-head verification before this handoff is green on PR #10 head `5480c77a59912f435c3f9d1bafc2985c23fbe531`, Verify #5 / run `34236822232` (tests + build success).

## Florence binary assets

Binary migration is complete and reproducible evidence is committed:

- 6 WebP visuals under `examples/florence/assets/visuals`;
- 6 assembled MP3 tracks under `examples/florence/assets/audio`;
- source visual Git blobs were matched exactly against pinned source SHA;
- every MP3 part was downloaded from the pinned source commit and its Git blob verified before ordered concatenation;
- migration workflow run `34237111169` succeeded and produced asset commit `cd9423f719a7a4ff81e05e3c486d174caea3e62f`;
- `asset-migration-manifest.json` records bytes/SHA-256/Git blob ids;
- root tests re-hash all 12 checked-out binaries;
- the temporary contents-write migration workflow was removed after the assets were committed and will not ship to `main`.

## Точный следующий шаг

Do **not** add another B11 feature slice.

1. wait only for the normal PR CI generated by the final docs/code/assets head;
2. require full root `npm run verify` success on that exact PR #35 head;
3. update PR #35 description with final acceptance evidence and exact CI run;
4. mark Engine PR #35 ready for review/publication;
5. ensure companion `sandbox` PR #10 is still green and update its stale B11.2 description to the accepted client-compatible state;
6. publish/merge in dependency-safe order: Engine first, then `sandbox` integration;
7. only after both publication gates are complete, start B12 release hardening.

If a later change touches Engine semantics, authored quest data, BFF compatibility or migrated binaries before merge, the exact-head CI evidence must be renewed. Do not reuse an older green run for a changed head.
