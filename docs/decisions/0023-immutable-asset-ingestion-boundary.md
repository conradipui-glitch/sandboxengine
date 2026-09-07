# ADR 0023 — Immutable asset ingestion and content-addressed storage boundary

Дата: 2026-09-07  
Статус: accepted for B07-02 functional publication gate

## Контекст

B07-01 опубликовал presentation identity `assetId + SHA-256 hash` и `AssetManifestV2`, но намеренно не определял, кто имеет право утверждать MIME, размеры, duration и hash загруженного файла.

Если доверять клиентскому `Content-Type`, имени файла, URL или присланному hash, immutable release перестаёт быть доказуемым: один и тот же логический asset может незаметно указывать на другие bytes, а SVG/HTML/script могут попасть в presentation path как «изображение».

## Решение

### 1. Отдельный infrastructure package

`@living-history/assets` является отдельной инфраструктурной границей и зависит только от `@living-history/contracts`.

Он не импортирует Core, Runtime, Control, Player или AI и не имеет WorldState/effects/turn/commit authority. Network, child process, environment-driven execution и remote URL fetch отсутствуют.

Внутренние обязанности разделены:

- `types.ts` — ошибки, limits, DTO helpers;
- `inspection.ts` — byte-signature/container metadata parsing и trusted SHA-256;
- `storage.ts` — immutable local content-addressed objects + exact registry read;
- `ingest.ts` — transport hints → proven inspection → canonical manifest → storage;
- `index.ts` — стабильный публичный facade.

### 2. Bytes являются источником истины

Server-side pipeline:

`untrusted bytes + hints → bounded inspection → trusted MIME/metadata → SHA-256(full bytes) → AssetManifestV2 → immutable object + exact assetId/hash registry record`.

`claimedMimeType` и filename extension — только consistency hints. Они никогда не определяют тип сами.

Client-supplied hash не существует в trusted input B07-02.

### 3. Bounded format profiles

B07-02 принимает только профили, metadata которых можно проверить локальным bounded parser без shell/ffmpeg/browser/full decode:

- PNG — signature/chunk bounds, first IHDR, final IEND;
- static WebP — RIFF + VP8X/VP8L/VP8 bounded metadata; animated VP8X rejected;
- JPEG — SOI/segment bounds, supported SOF dimensions, final EOI without trailing bytes;
- integer PCM WAV — consistent channels/sampleRate/bits/blockAlign/byteRate + aligned data duration;
- Ogg Vorbis — bounded Ogg pages, BOS, Vorbis identification sample rate, final granule duration;
- MP3 Layer III — bounded complete frame stream with supported MPEG rate/bitrate profile.

SVG/XML/HTML/script, unknown binary and unsupported codec/profile are fail-closed.

### 4. Explicit resource bounds

Ingestion has positive-safe-integer limits for:

- input bytes;
- image width/height/pixels;
- audio duration;
- filename metadata;
- alt/source/rights text.

Config may tighten canonical metadata bounds, not widen them beyond `AssetManifestV2`.

The parser reads bounded headers/tables directly; it does not allocate an image surface proportional to attacker-declared dimensions.

### 5. Content-addressed immutable object identity

Object path derives only from trusted SHA-256:

`<root>/objects/<hash-prefix>/<hash>`.

Logical registry path does not use raw `assetId`: assetId is validated, then independently SHA-256-hashed for path derivation. Original filename never participates in storage addressing.

Publication is create-if-absent via temporary file + hard link. Existing targets are never overwritten. Same hash deduplicates only after integrity verification. A filesystem that cannot provide the required atomic primitive fails rather than silently degrading to overwrite semantics.

### 6. Logical versioning is exact assetId + hash

Registry records are immutable exact identities.

- same assetId + same bytes/metadata → idempotent;
- same bytes under another assetId may share object bytes but get a distinct logical record;
- same assetId + new bytes → new hash/version record;
- old assetId + old hash remains readable;
- no mutable “latest URL” may stand in for a frozen release reference.

No destructive GC is performed in B07-02.

### 7. Safe read verifies stored identity

Read requires exact `assetId + hash`, loads the corresponding immutable registry record, then verifies stored object byte length and SHA-256 before returning bytes.

Missing/corrupt identity is explicit. The store never substitutes another version with the same assetId.

## Честная граница доказательства

B07-02 is **not a full media decoder/validator**. It proves bounded container/header structure, trusted metadata for the supported profile, and exact content identity. It does not validate every PNG/JPEG/WebP compressed stream checksum or prove that every accepted compressed payload will decode in every browser/audio implementation.

Therefore B07-03 Player presentation execution must treat image/audio decode/load failure as a normal presentation failure with neutral fallback. It must not replay gameplay, replace another asset silently, or reinterpret asset validity.

This limitation does not weaken immutable identity: if a stored payload later fails decode, the exact failed bytes/hash remain known.

## Последствия

Плюсы:

- frozen release references become content-stable;
- malicious filename/MIME/path cannot redirect storage;
- executable web asset types are excluded instead of sanitized ad hoc;
- old presentation references survive logical replacement;
- Player can consume one verified manifest/read boundary in B07-03.

Цена:

- first supported codec/profile set is intentionally narrower than filename extensions in the wild;
- local hard-link publication requires compatible filesystem semantics;
- browser decode fallback remains required even for accepted compressed assets;
- upload HTTP/auth and Studio asset manager remain future slices.

## Не решает

- public upload endpoint/auth/quotas;
- remote URL import;
- transcoding/thumbnails/variants pipeline;
- destructive GC;
- browser renderer/audio playback;
- Studio material manager;
- B08 plugins or gameplay changes.
