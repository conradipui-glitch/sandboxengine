import test from "node:test";
import assert from "node:assert/strict";
import { writeStoredZip } from "../dist/zip-store.js";
import {
  MAX_LHQUEST_ARCHIVE_BYTES,
  MAX_LHQUEST_ENTRY_BYTES,
  MAX_LHQUEST_FILE_COUNT,
  readBoundedStoredZip
} from "../dist/zip-read.js";

const bytes = (value) => new TextEncoder().encode(value);

test("B09-03 canonical ZIP writer never exceeds parser member/count bounds", () => {
  assert.throws(
    () => writeStoredZip([{ path: "too-large.bin", bytes: new Uint8Array(MAX_LHQUEST_ENTRY_BYTES + 1) }]),
    /ZIP entry outside bounds/
  );

  const tooMany = Array.from({ length: MAX_LHQUEST_FILE_COUNT + 1 }, (_, index) => ({
    path: `entry-${index}.txt`,
    bytes: bytes("x")
  }));
  assert.throws(() => writeStoredZip(tooMany), /ZIP entry count outside bounds/);
});

test("B09-03 bytes emitted by the canonical writer stay inside the canonical parser envelope", () => {
  const payload = new Uint8Array(Math.min(MAX_LHQUEST_ENTRY_BYTES, 512 * 1024));
  payload.fill(0x61);
  const archive = writeStoredZip([
    { path: "manifest.json", bytes: bytes("{}\n") },
    { path: "quest.json", bytes: payload },
    { path: "SHA256SUMS", bytes: bytes("placeholder\n") }
  ]);

  assert.ok(archive.byteLength <= MAX_LHQUEST_ARCHIVE_BYTES);
  const parsed = readBoundedStoredZip(archive);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.get("quest.json")?.bytes.byteLength, payload.byteLength);
});
