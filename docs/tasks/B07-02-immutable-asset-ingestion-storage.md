# B07-02 — Immutable asset registry + validated ingestion/storage boundary

## Цель

После published B07-01 добавить серверный asset boundary, который принимает байты, самостоятельно определяет/проверяет поддерживаемый тип, вычисляет content hash и сохраняет immutable object. Presentation/Player должны ссылаться только на проверенные `assetId + hash`, а не на произвольные URL или доверенный client MIME.

База: published B07-01 merge `b52b3ee8fe8d890c22b62f1b6ebd27cda7fda2c4`, main CI `34083673425` — success.

Канонический источник: `docs/SPECIFICATION.md` §10.5 и общие import/security boundaries.

## Главный invariant

**Клиент предлагает файл и metadata; сервер сам доказывает content identity/type/bounds. Сохранённый blob immutable, а published presentation reference всегда указывает на проверенный content hash. Asset ingestion не исполняет содержимое и не расширяет gameplay authority.**

## Сделать

### 1. Новый bounded assets package

Добавить `@living-history/assets` как инфраструктурный пакет, отдельный от Core/Runtime gameplay calculation.

Он отвечает только за:

- byte validation/sniffing;
- trusted SHA-256 content hash;
- image/audio metadata extraction в поддерживаемом subset;
- immutable content-addressed storage;
- asset registry records / lookup;
- safe read access по verified identity.

Не давать package возможности менять WorldState, turn, effects или quest draft напрямую.

### 2. Supported first formats

Первая версия принимает только bounded raster/audio subset:

- PNG;
- WebP;
- JPEG;
- MP3;
- Ogg audio;
- WAV.

Явно отклонять:

- SVG;
- HTML/XML;
- JavaScript/executable content;
- неизвестный/неподдержанный binary type;
- файл, у которого claimed MIME/extension не совпадает с доказанным content type.

Тип определяется по bytes/signature + bounded format metadata parsing. Не доверять `Content-Type` клиента как доказательству.

### 3. Ingestion request/result

Input минимум:

- requested stable `assetId`;
- bytes;
- claimed MIME (optional transport hint, never authority);
- alt text for visual asset;
- source/rights metadata;
- optional original filename as display metadata only.

Successful result возвращает trusted `AssetManifestV2` + storage identity.

Hash никогда не принимается от клиента как trusted value: вычисляется server-side по полным bytes.

### 4. Bounds

Добавить explicit configurable limits with safe defaults:

- max input bytes;
- max image width/height;
- max image pixels;
- max audio duration where deterministically extractable in supported parser;
- bounded metadata text lengths.

До full decode не аллоцировать структуры пропорционально заявленным untrusted dimensions.

Malformed/truncated headers fail closed.

### 5. Metadata extraction

Для accepted content извлекать server-side минимум, нужный B07 contracts:

- exact MIME;
- image width/height;
- audio duration when supported by deterministic bounded parser, otherwise reject format/profile rather than invent duration;
- hash.

Do not invoke browser/ffmpeg/shell/external URL to inspect uploads in this slice.

### 6. Immutable content-addressed storage

Local reference implementation:

- storage root supplied by server configuration;
- object path derived only from trusted hash, never original filename/path;
- safe temp write + atomic publish/rename where supported;
- existing same-hash bytes deduplicate;
- existing hash with non-identical bytes is integrity error;
- stored object is never overwritten in place;
- read verifies identity/expected size at minimum; optional rehash policy may be separate helper.

No path traversal from asset ID, filename or MIME.

### 7. Registry semantics

Registry stores immutable records keyed by `(assetId, hash)` or equivalent stable identity.

Requirements:

- same bytes under same ID are idempotent;
- replacing bytes for same logical `assetId` creates a **new hash/version record**, old object remains addressable;
- same content may deduplicate object bytes while retaining explicit logical records;
- lookup by exact `assetId + hash`;
- no mutable “latest URL” is sufficient for a frozen release;
- variant relationships/source/rights may live in registry metadata without breaking already-published `AssetManifestV2` schema.

Deletion/garbage collection of referenced published assets is not performed automatically in B07-02; safe GC policy can be later.

### 8. Safe read boundary

Expose bytes only by verified stored identity. Response metadata uses trusted registry MIME; never reflects arbitrary user header.

Missing/corrupt object returns explicit error/fallback signal; it must not silently substitute another asset with same ID.

### 9. Security tests

Минимум:

- PNG/WebP/JPEG valid fixture accepted with trusted dimensions/hash;
- WAV/one bounded audio fixture accepted with trusted duration;
- claimed MIME mismatch rejected;
- truncated/malformed signatures rejected;
- SVG/HTML/script content rejected even when renamed `.png`;
- path traversal filename/asset ID cannot escape storage root;
- oversized bytes rejected before persistent write;
- absurd image dimensions/pixel count rejected;
- hash calculated from actual bytes;
- same bytes are idempotent/deduplicated;
- same asset ID + different bytes creates new immutable record and retains old record;
- exact old `assetId + hash` remains readable;
- missing/corrupt blob fails explicitly;
- no shell/network/process execution;
- root `npm run verify` green.

### 10. Generated docs / boundaries

Если assets package экспортирует публичный contract/capability, generated docs должны отражать только реально реализованную возможность. Не добавлять Control upload endpoint в available OpenAPI до его фактической реализации.

## Functional acceptance

B07-02 functional gate закрыт, когда:

1. server-side bytes determine accepted MIME/metadata/hash;
2. unsupported/executable/malformed/oversized assets fail closed;
3. immutable content-addressed storage cannot be redirected by user paths;
4. registry preserves old content identity when same logical asset ID is replaced;
5. exact `AssetManifestV2` emitted by ingestion passes B07-01 manifest validator;
6. deterministic asset tests + root `npm run verify` green;
7. no browser renderer/Studio UI/B08 scope entered.

## Не делать

- arbitrary SVG sanitization/renderer;
- video/3D formats;
- remote URL fetch/import;
- ffmpeg/ImageMagick/shell transcoding;
- public upload HTTP endpoint/auth — later bounded slice/B09 boundary as appropriate;
- browser animation/audio executor;
- final Player redesign;
- Studio asset manager UI;
- destructive GC of published references;
- B08 UI plugins or gameplay changes.

## Следующий slice

После published B07-02: **B07-03 — Player presentation executor: SceneFrame restore + bounded plan playback + skip/reduced-motion/reload/idempotent turn behavior**, используя только verified asset registry outputs.