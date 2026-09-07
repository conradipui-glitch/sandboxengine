import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AssetBoundaryError,
  DEFAULT_ASSET_LIMITS,
  LocalAssetStore,
  ingestAsset,
  inspectAssetBytes,
  sha256AssetBytes
} from "../dist/index.js";
import { hasValidAssetManifestV2 } from "@living-history/contracts";

const PNG = png(2, 3);
const WEBP = webpVp8x(4, 5);
const JPEG = jpeg(6, 7);
const WAV = wavPcm({ sampleRate: 8_000, dataBytes: 800 });
const OGG = oggVorbis({ sampleRate: 48_000, granule: 4_800 });
const MP3 = mp3Frames(4);

test("B07-02 byte sniffing accepts bounded PNG/WebP/JPEG/WAV/Ogg Vorbis/MP3 profiles", () => {
  assert.deepEqual(inspectAssetBytes(PNG), {
    kind: "image", mimeType: "image/png", widthPx: 2, heightPx: 3, durationMs: null
  });
  assert.deepEqual(inspectAssetBytes(WEBP), {
    kind: "image", mimeType: "image/webp", widthPx: 4, heightPx: 5, durationMs: null
  });
  assert.deepEqual(inspectAssetBytes(JPEG), {
    kind: "image", mimeType: "image/jpeg", widthPx: 6, heightPx: 7, durationMs: null
  });
  assert.deepEqual(inspectAssetBytes(WAV), {
    kind: "audio", mimeType: "audio/wav", widthPx: null, heightPx: null, durationMs: 100
  });
  assert.deepEqual(inspectAssetBytes(OGG), {
    kind: "audio", mimeType: "audio/ogg", widthPx: null, heightPx: null, durationMs: 100
  });
  assert.deepEqual(inspectAssetBytes(MP3), {
    kind: "audio", mimeType: "audio/mpeg", widthPx: null, heightPx: null, durationMs: 104
  });
});

test("ingestion derives trusted hash/metadata and emits canonical AssetManifestV2", async (t) => {
  const root = await tempRoot(t);
  const store = new LocalAssetStore(root);
  const record = await ingestAsset(store, {
    assetId: "workshop-bg",
    bytes: PNG,
    claimedMimeType: "image/png",
    originalFilename: "workshop.png",
    altText: "Мастерская",
    source: "fixture",
    rights: "test-only"
  });

  const expectedHash = createHash("sha256").update(PNG).digest("hex");
  assert.equal(record.manifest.hash, expectedHash);
  assert.equal(sha256AssetBytes(PNG), expectedHash);
  assert.equal(record.manifest.mimeType, "image/png");
  assert.equal(record.manifest.widthPx, 2);
  assert.equal(record.manifest.heightPx, 3);
  assert.equal(record.storageKey, `sha256:${expectedHash}`);
  assert.equal(hasValidAssetManifestV2(record.manifest), true);

  const loaded = await store.read("workshop-bg", expectedHash);
  assert.deepEqual([...loaded.bytes], [...PNG]);
  assert.equal(loaded.record.manifest.mimeType, "image/png");
});

test("claimed MIME and known filename extension are hints that must agree with proven bytes", async (t) => {
  const root = await tempRoot(t);
  const store = new LocalAssetStore(root);
  await rejectsCode(() => ingestAsset(store, {
    assetId: "mismatch-mime",
    bytes: PNG,
    claimedMimeType: "image/jpeg",
    originalFilename: "image.png",
    altText: "x"
  }), "mime_mismatch");

  await rejectsCode(() => ingestAsset(store, {
    assetId: "mismatch-extension",
    bytes: PNG,
    claimedMimeType: "image/png",
    originalFilename: "image.jpg",
    altText: "x"
  }), "extension_mismatch");
});

test("SVG/HTML/script/unknown and malformed headers fail closed even when renamed as raster", async (t) => {
  const root = await tempRoot(t);
  const store = new LocalAssetStore(root);
  for (const [assetId, text] of [
    ["svg", "<svg xmlns='http://www.w3.org/2000/svg'></svg>"],
    ["html", "<!doctype html><script>alert(1)</script>"],
    ["script", "<script>commitTurn()</script>"]
  ]) {
    await rejectsCode(() => ingestAsset(store, {
      assetId,
      bytes: new TextEncoder().encode(text),
      claimedMimeType: "image/png",
      originalFilename: `${assetId}.png`,
      altText: "x"
    }), "unsupported_type");
  }

  assert.throws(() => inspectAssetBytes(new Uint8Array([1, 2, 3, 4])), hasCode("unsupported_type"));
  assert.throws(() => inspectAssetBytes(PNG.subarray(0, 16)), hasCode("malformed_content"));
  assert.throws(() => inspectAssetBytes(WAV.subarray(0, 30)), hasCode("malformed_content"));
  assert.throws(() => inspectAssetBytes(OGG.subarray(0, 20)), hasCode("malformed_content"));
  assert.throws(() => inspectAssetBytes(MP3.subarray(0, 100)), hasCode("malformed_content"));
});

test("explicit byte/dimension/pixel/audio-duration bounds reject before storage publication", async (t) => {
  const root = await tempRoot(t);
  const store = new LocalAssetStore(root);
  const tinyLimit = { ...DEFAULT_ASSET_LIMITS, maxInputBytes: 10 };
  await rejectsCode(() => ingestAsset(store, {
    assetId: "too-big",
    bytes: PNG,
    originalFilename: "x.png",
    altText: "x"
  }, tinyLimit), "too_large");
  await assert.rejects(readFile(join(root, "objects")), /ENOENT/);

  assert.throws(() => inspectAssetBytes(png(9_000, 2)), hasCode("dimensions_exceeded"));
  assert.throws(() => inspectAssetBytes(png(7_000, 7_000)), hasCode("dimensions_exceeded"));
  assert.throws(() => inspectAssetBytes(WAV, { ...DEFAULT_ASSET_LIMITS, maxAudioDurationMs: 50 }), hasCode("duration_exceeded"));
});

test("content-addressed objects deduplicate while logical asset versions stay immutable and old hashes remain readable", async (t) => {
  const root = await tempRoot(t);
  const store = new LocalAssetStore(root);
  const first = await ingestAsset(store, imageRequest("cover", PNG, "cover.png"));
  const retry = await ingestAsset(store, imageRequest("cover", PNG, "cover.png"));
  assert.equal(retry.manifest.hash, first.manifest.hash);

  const objectCountBeforeAlias = await countFiles(join(root, "objects"));
  const alias = await ingestAsset(store, imageRequest("cover-alias", PNG, "alias.png"));
  assert.equal(alias.storageKey, first.storageKey);
  assert.equal(await countFiles(join(root, "objects")), objectCountBeforeAlias, "same bytes must not create a second object blob");

  const replacementBytes = png(3, 3);
  const replacement = await ingestAsset(store, imageRequest("cover", replacementBytes, "cover.png"));
  assert.notEqual(replacement.manifest.hash, first.manifest.hash);

  const old = await store.read("cover", first.manifest.hash);
  const current = await store.read("cover", replacement.manifest.hash);
  assert.deepEqual([...old.bytes], [...PNG]);
  assert.deepEqual([...current.bytes], [...replacementBytes]);
  assert.equal(old.record.manifest.hash, first.manifest.hash);
});

test("assetId paths are rejected and traversal-like original filename is inert display metadata", async (t) => {
  const root = await tempRoot(t);
  const store = new LocalAssetStore(root);
  await rejectsCode(() => ingestAsset(store, imageRequest("../../escape", PNG, "escape.png")), "invalid_request");

  const record = await ingestAsset(store, imageRequest("safe-id", PNG, "../../outside.png"));
  assert.equal(record.originalFilename, "../../outside.png");
  await store.read("safe-id", record.manifest.hash);
  await assert.rejects(readFile(join(dirname(root), "outside.png")), /ENOENT/);
});

test("safe read is exact: missing identity and corrupted content never substitute another version", async (t) => {
  const root = await tempRoot(t);
  const store = new LocalAssetStore(root);
  const record = await ingestAsset(store, imageRequest("portrait", PNG, "portrait.png"));

  await rejectsCode(() => store.read("portrait", "f".repeat(64)), "not_found");
  const objectPath = join(root, "objects", record.manifest.hash.slice(0, 2), record.manifest.hash);
  await writeFile(objectPath, new Uint8Array([9, 9, 9]));
  await rejectsCode(() => store.read("portrait", record.manifest.hash), "corrupt_object");
});

test("registry records are immutable for one exact assetId + hash", async (t) => {
  const root = await tempRoot(t);
  const store = new LocalAssetStore(root);
  const record = await ingestAsset(store, imageRequest("immutable-meta", PNG, "a.png"));
  await rejectsCode(() => store.put({
    ...record,
    manifest: { ...record.manifest, altText: "changed after publication" }
  }, PNG), "storage_integrity");
});

test("assets package has no network/process/gameplay authority imports", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  for (const forbidden of [
    "@living-history/core",
    "@living-history/runtime",
    "@living-history/control",
    "@living-history/player",
    "@living-history/ai",
    "node:child_process",
    "node:http",
    "node:https",
    "process.env",
    "fetch("
  ]) assert.equal(source.includes(forbidden), false, `asset boundary must not contain ${forbidden}`);
});

function imageRequest(assetId, bytes, originalFilename) {
  return {
    assetId,
    bytes,
    claimedMimeType: "image/png",
    originalFilename,
    altText: "Безопасное изображение",
    source: "fixture",
    rights: "test-only"
  };
}

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "lhe-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function rejectsCode(fn, code) {
  await assert.rejects(fn, hasCode(code));
}

function hasCode(code) {
  return (error) => error instanceof AssetBoundaryError && error.code === code;
}

async function countFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  for (const entry of entries) {
    const path = join(root, entry.name);
    count += entry.isDirectory() ? await countFiles(path) : 1;
  }
  return count;
}

function png(width, height) {
  const bytes = new Uint8Array(45);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  writeU32BE(bytes, 8, 13);
  writeAscii(bytes, 12, "IHDR");
  writeU32BE(bytes, 16, width);
  writeU32BE(bytes, 20, height);
  bytes[24] = 8;
  bytes[25] = 2;
  writeU32BE(bytes, 33, 0);
  writeAscii(bytes, 37, "IEND");
  return bytes;
}

function webpVp8x(width, height) {
  const bytes = new Uint8Array(30);
  writeAscii(bytes, 0, "RIFF");
  writeU32LE(bytes, 4, 22);
  writeAscii(bytes, 8, "WEBP");
  writeAscii(bytes, 12, "VP8X");
  writeU32LE(bytes, 16, 10);
  writeU24LE(bytes, 24, width - 1);
  writeU24LE(bytes, 27, height - 1);
  return bytes;
}

function jpeg(width, height) {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11,
    0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0xff, 0xd9
  ]);
}

function wavPcm({ sampleRate, dataBytes }) {
  const bytes = new Uint8Array(44 + dataBytes);
  writeAscii(bytes, 0, "RIFF");
  writeU32LE(bytes, 4, bytes.length - 8);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  writeU32LE(bytes, 16, 16);
  writeU16LE(bytes, 20, 1);
  writeU16LE(bytes, 22, 1);
  writeU32LE(bytes, 24, sampleRate);
  writeU32LE(bytes, 28, sampleRate);
  writeU16LE(bytes, 32, 1);
  writeU16LE(bytes, 34, 8);
  writeAscii(bytes, 36, "data");
  writeU32LE(bytes, 40, dataBytes);
  return bytes;
}

function oggVorbis({ sampleRate, granule }) {
  const bodyLength = 30;
  const bytes = new Uint8Array(27 + 1 + bodyLength);
  writeAscii(bytes, 0, "OggS");
  bytes[4] = 0;
  bytes[5] = 0x06;
  writeU64LE(bytes, 6, BigInt(granule));
  bytes[26] = 1;
  bytes[27] = bodyLength;
  const body = 28;
  bytes[body] = 1;
  writeAscii(bytes, body + 1, "vorbis");
  writeU32LE(bytes, body + 7, 0);
  bytes[body + 11] = 1;
  writeU32LE(bytes, body + 12, sampleRate);
  bytes[body + 29] = 1;
  return bytes;
}

function mp3Frames(count) {
  const frameLength = Math.floor((144 * 128_000) / 44_100);
  const bytes = new Uint8Array(frameLength * count);
  for (let index = 0; index < count; index += 1) {
    const offset = index * frameLength;
    bytes.set([0xff, 0xfb, 0x90, 0x00], offset);
  }
  return bytes;
}

function writeAscii(bytes, offset, value) {
  for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
}

function writeU16LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeU24LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
}

function writeU32BE(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function writeU32LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function writeU64LE(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset + offset, 8).setBigUint64(0, value, true);
}
