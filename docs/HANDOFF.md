# Передача работы

Обновлено: 2026-09-07

Текущий блок: **B06-03 — Narrator + FactPacket + deterministic fallback / T13 T14**  
База: published B06-02 merge `90e6bcb4de1da2d0b37b5bc128406dcb0078b3a1`  
B06-02 push-CI main: `34057996331` — success  
Ветка: `b06-03-narrator-factpacket-fallback`  
PR: #22  
Статус: **functional hardening gate `34080825132` success на `12894d63bf64e290a854249438ec9f7c555177e1`; docs sync → final current-head CI → merge/main publication gate**

## Что уже published

B01–B05, B06-01 и B06-02 published.

Published B06-01 merge: `a08f3434060abe699be5d431464597645557b8f9`; main CI `34056977026` — success.  
Published B06-02 merge: `90e6bcb4de1da2d0b37b5bc128406dcb0078b3a1`; main CI `34057996331` — success.

B06-02 даёт safe free-text boundary: claim-before-AI → bounded intent understanding → validated `ResolvedIntent` → тот же Core resolver, что explicit action. Processing outcomes clarification/unsupported/failed не создают turn.

## Что реализовано в B06-03

### Narrator authority boundary

Narrator работает только после Core calculation.

Canonical calculated turn:

`claim → optional intent → Core → FactPacket → narrator/validator or fallback → public response → one commitTurn`.

Narrator никогда не определяет action status, resource cost, duration, effects или candidate state и не запускает Core повторно.

### FactPacket

`buildFactPacket` создаёт bounded serializable presentation input из trusted before-state + Core execution.

В packet входят:

- action type/status/requested/completed/duration/reason;
- public before/after clock;
- изменившиеся public resource values + units;
- bounded visible speaker IDs;
- bounded observation allowlist.

Не входят full `WorldState`, resource min/max, items, contentHash, fencing/idempotency/storage metadata, effects/statePatch или executable data.

### Strict / expressive profiles

Оба profile используют один FactPacket и один exact validator. `expressive` отличается только style/output budget и не получает дополнительных прав.

Narrative proposal принимает только:

- summary;
- dialogue с speaker ID из allowlist;
- observation refs из allowlist.

Unknown speaker/ref, hidden asset, effects/statePatch/action mutation или extra authority key → invalid → fallback.

### Deterministic fallback

Для executed/partial/blocked есть локальный deterministic renderer.

Narrator timeout/network/invalid/empty/exhausted attempts после Core не отменяет действие: Runtime выбирает fallback и делает ровно один commit.

Narrator имеет максимум две attempts, repair входит в этот лимит.

### Один AI deadline

После successful claim Runtime создаёт один absolute deadline. Для free-text тот же timestamp передаётся intent interpreter, затем narrator использует остаток времени.

Explicit action bypasses intent, но narrator работает под той же operation deadline policy.

### Persisted replay

Narrative входит в тот же committed public response, что structured action/playerView.

Повтор idempotency key возвращает persisted payload без новых intent/narrator/Core calls.

### Player surface

Narrative optional и backward-compatible.

Без narrator старый Runtime payload остаётся валиден. С narrator Player получает только:

- profile;
- source;
- summary;
- dialogue;
- observationRefs.

Usage/model/provider request IDs и attempt evidence не публикуются. UI отображает narrative с escaping; numeric resource/time/action данные продолжает брать из structured fields.

ADR: `docs/decisions/0020-narrator-factpacket-single-commit-boundary.md`.

## CI evidence

- ранний AI-layer CI `34058185395` выявил только test-harness deadline bug: absolute `10_000` был уже в прошлом относительно real `Date.now()`;
- `495386af68ddc0fbe036806f4af148a57fb0011a`: corrected future deadline harness;
- `f20c2984af06ccf918dae558e9a835b7d6997c0c`: Core execution → bounded FactPacket + optional public narrative;
- `31ff34edc886cc167ae17e1b401ba4060083e2d5`: Runtime narrator stage, shared deadline, fallback before single commit;
- `92899bd6a80b32e22e61d983bb9826e5f77320cc`: Runtime T13/shared-deadline tests;
- `55d66b96b5043c7c8e45e100b4e4e7f693bd64a3` + `7cc0422ad806c952ba893c705aafff578d7a76cb`: Player optional narrative contract/tests;
- `131ea960063ea2a0af7a9dd1a79abfa552af79ab`: Player narrative render; CI `34080761099` success;
- `12894d63bf64e290a854249438ec9f7c555177e1`: final acceptance hardening; CI `34080825132` — **success**.

## Functional acceptance state

Закрыто функционально:

- Core-derived FactPacket without known secret/internal fields;
- strict/expressive same-authority boundary;
- max 2 narrator attempts;
- T13 narrator failure → fallback + exactly one commit;
- T14 unknown speaker/authority mutation → reject/fallback;
- valid narrator cannot change structured action/playerView;
- one shared intent+narrator absolute deadline;
- replay performs no new AI/Core work;
- provider diagnostics absent from public narrative;
- legacy Runtime/Player compatibility green;
- root `npm run verify` green;
- AgentBackend/Codex scope не входил в PR.

## Честная граница

Fake-provider tests доказывают structural/causal safety и deterministic fallback. Они не являются доказательством качества real Russian narration, semantic faithfulness любого expressive output или выбора production model.

Это нужно проверять bounded live eval/manual playtest в следующем slice.

## Publication Gate B06-03

Осталось:

1. final current-head PR CI после docs sync;
2. mark PR #22 ready;
3. merge с pinned expected head SHA;
4. verify push-to-main CI на exact merge SHA;
5. только после green main объявить B06-03 published.

## Следующее после публикации B06-03

**B06-04 — AgentBackend/Codex compatibility spike + bounded live eval + canonical B06 audit**:

- зафиксировать отдельный session-oriented AgentBackend contract, не маскируя его под stateless Chat Completions;
- проверить Codex/login/session/rate-limit compatibility bounded spike без превращения spike в production dependency;
- провести bounded live intent/narrator eval на выбранных provider/model profiles и честно отделить language quality от contract correctness;
- свести B06-01…03 в canonical audit: authority, deadline/retry, secrets, quotas, idempotency, fallback, public diagnostics;
- только после B06 audit решать следующий engine stage.

Создать B06-04 отдельной веткой **только от verified B06-03 merge SHA**.

## Не делать сейчас

AgentBackend/Codex implementation внутри PR #22, final Studio connection UI, B07 PresentationPlan/assets/animations/audio, B08 plugins, B09 auth/public publish, B10 author AI, B11 Florence migration, long-term dialogue/RAG memory или force dependency upgrade.
