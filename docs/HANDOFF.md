# Передача работы

Обновлено: 2026-09-07

Текущий блок: **B07-02 — immutable asset ingestion/storage boundary**  
База: published B07-01 merge `b52b3ee8fe8d890c22b62f1b6ebd27cda7fda2c4`  
B07-01 main push CI: `34083673425` — success  
Ветка: `b07-02-immutable-asset-ingestion-storage`  
PR: #25  
Статус: **functional/refactor gate `34092033369` success on `f378c6e40f340f1ffb8c4f8172c09020fa39658c`; unresolved BLOCKER=0; docs/current-head CI → pinned merge/main publication gate**

## Published state before current block

B01–B06 and B07-01 published.

B07-01:

- merge `b52b3ee8fe8d890c22b62f1b6ebd27cda7fda2c4`;
- main CI `34083673425` — success;
- canonical presentation schema `2.0`;
- reload-safe `SceneFrameV2`;
- bounded/non-executable `PresentationPlanV2`;
- immutable presentation ref `assetId + SHA-256`;
- target-frame convergence + stale/replay decisions.

Legacy presentation v1 remains frozen/readable.

## B07-02 implementation

Task: `docs/tasks/B07-02-immutable-asset-ingestion-storage.md`.  
Decision: `docs/decisions/0023-immutable-asset-ingestion-boundary.md`.  
Worklog: `docs/worklog/2026-09-07-b07-02.md`.

### Package boundary

New package: `@living-history/assets`.

Dependencies: only `@living-history/contracts`.

Source split:

- `packages/assets/src/types.ts`;
- `packages/assets/src/inspection.ts`;
- `packages/assets/src/storage.ts`;
- `packages/assets/src/ingest.ts`;
- `packages/assets/src/index.ts` facade.

Root `test:assets` is part of `npm run verify`.

`check:boundaries` rejects Assets imports of Core/Runtime/Control/Player/AI, apps, network, child process and process env. Filesystem/path/crypto are intentionally allowed infrastructure dependencies.

### Canonical ingestion path

`bytes → bounded inspection → trusted MIME/dimensions/duration → SHA-256(full bytes) → AssetManifestV2 → LocalAssetStore.put`.

Input may carry claimed MIME and original filename only as consistency/display hints. They are never content authority.

Hash is never accepted as trusted client input.

### Bounded media profiles

Accepted only when current parser proves the profile:

- PNG: signature/chunk bounds, first IHDR, final IEND;
- static WebP: RIFF + bounded VP8X/VP8L/VP8 metadata, animation flag rejected;
- JPEG: SOI/segments/supported SOF/final EOI, no trailing bytes;
- integer PCM WAV: channels/sampleRate/bits/blockAlign/byteRate consistency, aligned data, deterministic duration;
- Ogg Vorbis: Ogg page bounds/BOS/Vorbis identification/final granule duration;
- MP3 Layer III: complete bounded frame stream, supported MPEG profile, deterministic duration.

Explicit failures:

- SVG/XML/HTML/script;
- unknown binary;
- unsupported codec/profile;
- claimed MIME mismatch;
- known filename extension mismatch;
- malformed/truncated headers;
- oversized bytes/dimensions/pixels/duration/metadata.

### Immutable content storage

Object path:

`<storageRoot>/objects/<sha-prefix>/<sha256>`.

Only trusted hash participates in object addressing.

Logical registry path hashes the validated assetId and includes exact content hash. Raw assetId and original filename cannot traverse storage paths.

Publish semantics:

- exclusive temp file;
- hard-link create-if-absent;
- target never overwritten;
- existing target verified before dedupe acceptance;
- unsupported atomic filesystem primitive fails closed.

### Registry/version semantics

- same assetId + same bytes/metadata → idempotent;
- same bytes + other assetId → shared object possible, separate logical record;
- same assetId + different bytes → new hash/version record;
- previous exact record remains addressable;
- read requires exact assetId + hash;
- read revalidates registry shape, byte length and SHA-256;
- missing/corrupt exact object fails instead of selecting “latest”.

No destructive GC in B07-02.

## Hardening history / CI

Initial integrated head `bc77b026821821b7dfeca63fcdabc760774b8b46` → CI `34091256043` success.

Post-green parser/storage hardening head `20d2f33e5b9dc3d4855f1927b3c93cda137b6849` → CI `34091540387` success.

Final responsibility split + WAV consistency/animated-WebP/BOS hardening head `f378c6e40f340f1ffb8c4f8172c09020fa39658c` → CI `34092033369` **success**, full root verify.

Unresolved BLOCKER after audit: **0**.

## Important limitation for B07-03

B07-02 does not fully decode every compressed raster/audio payload and does not prove browser decoder acceptance. It proves bounded container/header metadata and exact bytes/hash identity.

Therefore B07-03 Player must:

- use verified `assetId + hash` outputs only;
- treat image/audio load/decode errors as presentation fallback;
- never retry/replay gameplay because an asset failed;
- never substitute another asset version silently;
- keep latest confirmed SceneFrame visible when media fails.

## Publication Gate

Remaining for B07-02:

1. final current-head PR CI after this docs sync;
2. update PR #25 evidence/body;
3. mark ready;
4. merge with `expected_head_sha` pinned to exact final head;
5. verify `event=push`, `head_branch=main`, `head_sha=<merge sha>` CI success;
6. only then call B07-02 published.

## Next bounded slice

After verified publication only:

**B07-03 — Player presentation executor**:

- restore latest SceneFrame without historical replay;
- play validated PresentationPlan sequence/parallel commands;
- skip/reduced-motion reaches exact target frame;
- same turn never plays twice;
- stale/gap recovery uses frame, not guessed transitions;
- media failure uses neutral fallback and leaves gameplay untouched.

Do not enter Studio timeline/editor, public upload/auth, B08 UI plugins, B09 publish/auth, B10 author AI or B11 Florence migration inside B07-02.
