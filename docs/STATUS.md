# Статус движка

Последнее обновление: 2026-09-07.

| Область | Состояние | Доказательство / следующий шаг |
|---|---|---|
| Репозиторий | **B01–B07-01 published; B07-02 functional gate green на PR #25** | B07-01 merge `b52b3ee8fe8d890c22b62f1b6ebd27cda7fda2c4`, main CI `34083673425`; B07-02 final functional head `f378c6e4…`, CI `34092033369` success → docs/current-head gate → pinned merge/main CI |
| Контракты/Core | **B01–B03 published** | deterministic gameplay authority; core schema `1.0` |
| Runtime storage/API | **B04 published** | idempotency/fencing/SQLite/guest HTTP |
| Authoring / Control | **B05 published** | draft → validation → frozen playtest → Player |
| AI foundation | **B06 published** | provider/intent/narrator/AgentBackend boundary; final merge `7a5efba36…`, main CI `34081697268` |
| Presentation contracts | **B07-01 published** | presentation schema `2.0`, SceneFrameV2, bounded PresentationPlanV2, immutable refs/convergence; merge `b52b3ee8…`, main CI `34083673425` |
| Asset ingestion/storage | **B07-02 accepted functionally** | `@living-history/assets`; trusted bytes→metadata/hash→immutable object/registry→exact read; final functional CI `34092033369`; ADR 0023 |
| Player presentation executor | не начато | B07-03 after B07-02 publication |
| Plugins | не начато | B08 |
| Auth/publish | не начато | B09 |
| Author AI helper | не начато | B10 |
| Florence migration | не начато | B11 |

## Published through B07-01

Canonical B06 final merge: `7a5efba36b508f674483dd9cce3762277917c5e1`; main CI `34081697268` — success.

B07-01 publication:

- PR #24;
- final PR head `3081cd7419f89b78b9232a8a26152bcad8b1a682`, CI `34083621254` — success;
- merge `b52b3ee8fe8d890c22b62f1b6ebd27cda7fda2c4`;
- exact main push CI `34083673425` — success.

B07-01 keeps legacy presentation v1 frozen and publishes canonical presentation schema `2.0`: full reload-safe `SceneFrameV2`, bounded/non-executable `PresentationPlanV2`, immutable `assetId + SHA-256`, stale/replay decisions and target-frame convergence.

## B07-02 — immutable asset ingestion/storage

Ветка: `b07-02-immutable-asset-ingestion-storage`.  
PR: #25.  
Карточка: [B07-02](tasks/B07-02-immutable-asset-ingestion-storage.md).  
Решение: [ADR 0023](decisions/0023-immutable-asset-ingestion-boundary.md).  
Worklog: [2026-09-07 B07-02](worklog/2026-09-07-b07-02.md).

### Authority boundary

Новый `@living-history/assets` — infrastructure-only package, зависящий только от contracts.

Он не имеет gameplay authority и не импортирует Core/Runtime/Control/Player/AI. Boundary checker также запрещает ему network, child process и process-env authority.

### Trusted ingestion path

`untrusted bytes + optional MIME/filename hints → bounded byte inspection → trusted MIME/dimensions/duration → SHA-256(full bytes) → canonical AssetManifestV2 → immutable content object + exact assetId/hash registry record`.

Client MIME, extension и filename не определяют тип; hash вычисляется только server-side.

### Supported bounded profiles

- PNG;
- static WebP;
- JPEG;
- integer PCM WAV;
- Ogg Vorbis;
- MP3 Layer III.

SVG/XML/HTML/script/unknown content и unsupported codec/profile fail closed. Animated WebP rejected.

Limits cover input bytes, width/height/pixels, audio duration and metadata lengths. Config can tighten canonical metadata limits but cannot widen them beyond `AssetManifestV2`.

### Immutable storage/registry

- object path derives only from trusted SHA-256;
- logical registry path hashes validated assetId and includes exact content hash;
- original filename never addresses filesystem objects;
- exclusive temp write + create-if-absent hard link;
- existing object/record never overwritten;
- same content deduplicates only after integrity verification;
- same assetId + different bytes creates a new immutable version;
- old exact `assetId + hash` remains readable;
- read checks record identity, byte length and SHA-256;
- missing/corrupt object fails explicitly with no version substitution.

### Hardening findings closed

After first green CI, audit found and closed:

- incomplete PNG termination validation;
- forged WebP chunk length;
- JPEG trailing bytes;
- hardcoded metadata limits;
- platform-specific registry dirname calculation;
- WAV duration trusting inconsistent byteRate/blockAlign;
- animated WebP timeline ambiguity;
- monolithic package responsibility split.

Final internal architecture: `types → inspection → storage → ingest → public facade`.

### Functional evidence

- initial integrated head `bc77b026821821b7dfeca63fcdabc760774b8b46` → CI `34091256043` success;
- hardened head `20d2f33e5b9dc3d4855f1927b3c93cda137b6849` → CI `34091540387` success;
- final functional/refactor head `f378c6e40f340f1ffb8c4f8172c09020fa39658c` → CI `34092033369` **success**, full root `npm run verify`.

Unresolved functional BLOCKER: **0**.

### Honest limitation

B07-02 proves bounded container/header structure, presentation metadata and exact bytes/hash. It is not a full codec decode/checksum validation pipeline for every compressed payload.

Therefore B07-03 must treat browser image/audio decode/load failure as normal presentation fallback. Such a failure must not trigger gameplay callbacks, replay Core, silently substitute another version or change the stored identity.

## Publication Gate B07-02

Осталось:

1. final current-head CI after ADR/STATUS/HANDOFF/worklog sync;
2. PR #25 mark ready;
3. merge pinned to exact expected head;
4. exact merge-SHA push-to-main CI;
5. only after green main say B07-02 published.

Then start **B07-03 — Player presentation executor** exactly from verified B07-02 merge SHA.

## Scope boundary

B07-02 does not add public upload HTTP/auth, remote URL import, ffmpeg/ImageMagick, destructive GC, browser animation/audio playback, final Player redesign, Studio asset manager, B08 plugins, B09 auth/public publish, B10 author AI or B11 Florence migration.
