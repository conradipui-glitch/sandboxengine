import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AssetBoundaryError,
  DEFAULT_ASSET_LIMITS,
  LocalAssetStore,
  ingestAsset,
  inspectAssetBytes
} from "../dist/index.js";

test("PNG requires a structurally complete final IEND instead of trusting IHDR only", () => {
  const complete = png(12, 8);
  assert.equal(inspectAssetBytes(complete).mimeType, "image/png");

  const withoutIend = complete.subarray(0, 33);
  assert.throws(() => inspectAssetBytes(withoutIend), hasCode("malformed_content"));

  const trailing = new Uint8Array(complete.length + 4);
  trailing.set(complete);
  trailing.set([0x3c, 0x73, 0x76, 0x67], complete.length);
  assert.throws(() => inspectAssetBytes(trailing), hasCode("malformed_content"));
});

test("WebP rejects forged first-chunk lengths even when RIFF and VP8X signatures look valid", () => {
  const valid = webpVp8x(16, 9);
  assert.deepEqual(inspectAssetBytes(valid), {
    kind: "image",
    mimeType: "image/webp",
    widthPx: 16,
    heightPx: 9,
    durationMs: null
  });

  const forged = Uint8Array.from(valid);
  writeU32LE(forged, 16, 100);
  assert.throws(() => inspectAssetBytes(forged), hasCode("malformed_content"));

  const wrongVp8xSize = Uint8Array.from(valid);
  writeU32LE(wrongVp8xSize, 16, 9);
  assert.throws(() => inspectAssetBytes(wrongVp8xSize), hasCode("malformed_content"));
});

test("JPEG requires final EOI and rejects bytes appended after the image identity", () => {
  const valid = jpeg(20, 10);
  assert.equal(inspectAssetBytes(valid).mimeType, "image/jpeg");
  assert.throws(() => inspectAssetBytes(valid.subarray(0, valid.length - 2)), hasCode("malformed_content"));

  const trailing = new Uint8Array(valid.length + 3);
  trailing.set(valid);
  trailing.set([1, 2, 3], valid.length);
  assert.throws(() => inspectAssetBytes(trailing), hasCode("malformed_content"));
});

test("metadata bounds are configurable downward but never wider than canonical AssetManifestV2", async (t) => {
  const root = await tempRoot(t);
  const store = new LocalAssetStore(root);
  const limits = {
    ...DEFAULT_ASSET_LIMITS,
    maxAltTextChars: 4,
    maxSourceChars: 5,
    maxRightsChars: 6,
    maxFilenameChars: 20
  };

  await assert.rejects(() => ingestAsset(store, {
    assetId: "bounded-alt",
    bytes: png(2, 2),
    originalFilename: "x.png",
    altText: "12345"
  }, limits), hasCode("invalid_request"));

  await assert.rejects(() => ingestAsset(store, {
    assetId: "bounded-source",
    bytes: png(2, 2),
    originalFilename: "x.png",
    altText: "1234",
    source: "123456"
  }, limits), hasCode("invalid_request"));

  assert.throws(() => inspectAssetBytes(png(2, 2), {
    ...DEFAULT_ASSET_LIMITS,
    maxAltTextChars: 1_001
  }), hasCode("invalid_request"));
  assert.throws(() => inspectAssetBytes(png(2, 2), {
    ...DEFAULT_ASSET_LIMITS,
    maxFilenameChars: 1_025
  }), hasCode("invalid_request"));
});

test("visual alt text stays mandatory and unknown filename extensions cannot masquerade as accepted content", async (t) => {
  const root = await tempRoot(t);
  const store = new LocalAssetStore(root);
  const bytes = png(2, 2);

  await assert.rejects(() => ingestAsset(store, {
    assetId: "no-alt",
    bytes,
    originalFilename: "x.png"
  }), hasCode("invalid_request"));

  await assert.rejects(() => ingestAsset(store, {
    assetId: "wrong-extension",
    bytes,
    originalFilename: "x.bin",
    altText: "x"
  }), hasCode("extension_mismatch"));

  const record = await ingestAsset(store, {
    assetId: "mime-params",
    bytes,
    claimedMimeType: "IMAGE/PNG; charset=binary",
    originalFilename: "x.PNG",
    altText: "x"
  });
  assert.equal(record.manifest.mimeType, "image/png");
});

test("bounded audio profiles reject codec/profile ambiguity instead of inventing duration", () => {
  const opusLike = new Uint8Array(64);
  writeAscii(opusLike, 0, "OggS");
  opusLike[4] = 0;
  opusLike[5] = 0x02;
  opusLike[26] = 1;
  opusLike[27] = 8;
  writeAscii(opusLike, 28, "OpusHead");
  assert.throws(() => inspectAssetBytes(opusLike), hasCode("unsupported_type"));

  const layer2Header = new Uint8Array([0xff, 0xfd, 0x90, 0x00, 0, 0, 0, 0]);
  assert.throws(() => inspectAssetBytes(layer2Header), hasCode("unsupported_type"));
});

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "lhe-assets-hardening-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function hasCode(code) {
  return (error) => error instanceof AssetBoundaryError && error.code === code;
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

function writeAscii(bytes, offset, value) {
  for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
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
