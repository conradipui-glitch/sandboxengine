import test from "node:test";
import assert from "node:assert/strict";
import {
  AssetBoundaryError,
  inspectAssetBytes
} from "../dist/index.js";

test("B07-02 PCM WAV duration is trusted only when byteRate/blockAlign match channel/sample metadata", () => {
  const valid = wavPcm({ sampleRate: 8_000, channels: 1, bitsPerSample: 8, dataBytes: 800 });
  assert.deepEqual(inspectAssetBytes(valid), {
    kind: "audio",
    mimeType: "audio/wav",
    widthPx: null,
    heightPx: null,
    durationMs: 100
  });

  const forgedByteRate = Uint8Array.from(valid);
  writeU32LE(forgedByteRate, 28, 4_000);
  assert.throws(() => inspectAssetBytes(forgedByteRate), hasCode("malformed_content"));

  const forgedBlockAlign = Uint8Array.from(valid);
  writeU16LE(forgedBlockAlign, 32, 2);
  assert.throws(() => inspectAssetBytes(forgedBlockAlign), hasCode("malformed_content"));

  const unalignedData = wavPcm({ sampleRate: 8_000, channels: 2, bitsPerSample: 16, dataBytes: 5 });
  assert.throws(() => inspectAssetBytes(unalignedData), hasCode("malformed_content"));
});

test("B07-02 animated WebP is rejected rather than smuggling an independent animation timeline", () => {
  const staticWebp = webpVp8x(16, 9, 0x00);
  assert.equal(inspectAssetBytes(staticWebp).mimeType, "image/webp");

  const animated = webpVp8x(16, 9, 0x02);
  assert.throws(() => inspectAssetBytes(animated), hasCode("unsupported_type"));
});

test("Ogg bounded profile requires BOS and still distinguishes Vorbis from other Ogg codecs", () => {
  const noBos = oggFirstPage("vorbis", 0x00);
  assert.throws(() => inspectAssetBytes(noBos), hasCode("malformed_content"));

  const opus = oggFirstPage("opus", 0x02);
  assert.throws(() => inspectAssetBytes(opus), hasCode("unsupported_type"));
});

function hasCode(code) {
  return (error) => error instanceof AssetBoundaryError && error.code === code;
}

function wavPcm({ sampleRate, channels, bitsPerSample, dataBytes }) {
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const pad = dataBytes % 2;
  const bytes = new Uint8Array(44 + dataBytes + pad);
  writeAscii(bytes, 0, "RIFF");
  writeU32LE(bytes, 4, bytes.length - 8);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  writeU32LE(bytes, 16, 16);
  writeU16LE(bytes, 20, 1);
  writeU16LE(bytes, 22, channels);
  writeU32LE(bytes, 24, sampleRate);
  writeU32LE(bytes, 28, byteRate);
  writeU16LE(bytes, 32, blockAlign);
  writeU16LE(bytes, 34, bitsPerSample);
  writeAscii(bytes, 36, "data");
  writeU32LE(bytes, 40, dataBytes);
  return bytes;
}

function webpVp8x(width, height, flags) {
  const bytes = new Uint8Array(30);
  writeAscii(bytes, 0, "RIFF");
  writeU32LE(bytes, 4, 22);
  writeAscii(bytes, 8, "WEBP");
  writeAscii(bytes, 12, "VP8X");
  writeU32LE(bytes, 16, 10);
  bytes[20] = flags;
  writeU24LE(bytes, 24, width - 1);
  writeU24LE(bytes, 27, height - 1);
  return bytes;
}

function oggFirstPage(codec, headerType) {
  const bodyLength = 30;
  const bytes = new Uint8Array(27 + 1 + bodyLength);
  writeAscii(bytes, 0, "OggS");
  bytes[4] = 0;
  bytes[5] = headerType;
  writeU64LE(bytes, 6, 4_800n);
  bytes[26] = 1;
  bytes[27] = bodyLength;
  const body = 28;
  if (codec === "vorbis") {
    bytes[body] = 1;
    writeAscii(bytes, body + 1, "vorbis");
    bytes[body + 11] = 1;
    writeU32LE(bytes, body + 12, 48_000);
    bytes[body + 29] = 1;
  } else {
    writeAscii(bytes, body, "OpusHead");
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

function writeU32LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function writeU64LE(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset + offset, 8).setBigUint64(0, value, true);
}
