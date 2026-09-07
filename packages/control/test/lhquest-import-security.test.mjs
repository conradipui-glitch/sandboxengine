import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  MemoryControlStore,
  buildDraftQuestExport,
  parseLhquestDraftPackage
} from "../dist/index.js";
import { writeStoredZip } from "../dist/zip-store.js";
import { MAX_LHQUEST_ARCHIVE_BYTES, MAX_LHQUEST_ENTRY_BYTES } from "../dist/zip-read.js";

const workshop = Object.freeze({
  schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Workshop", description: "", data: Object.freeze({})
});
const paint = Object.freeze({
  schemaVersion: "1.0", id: "paint", kind: "core.resource", title: "Paint", description: "",
  data: Object.freeze({ unit: "portion", initialValue: 4, min: 0, max: 20 })
});
const action = Object.freeze({
  schemaVersion: "1.0", id: "paint-wall", kind: "core.action", title: "Paint wall", description: "",
  data: Object.freeze({ actionType: "core.paint", resourceId: "paint", resourceUnitsPerUnit: 1, durationSecondsPerUnit: 300, allowPartial: true })
});

async function canonicalPackage() {
  const store = new MemoryControlStore();
  assert.equal((await store.createProject({ projectId: "p", title: "P" })).kind, "created");
  assert.equal((await store.createQuest({
    projectId: "p", questId: "q", title: "Quest", entryLocationId: "workshop", initialBlocks: [workshop, paint, action]
  })).kind, "created");
  const exported = await buildDraftQuestExport(store, "p", "q", 0);
  assert.equal(exported.kind, "exported");
  const entries = readStoredEntries(exported.value.archive);
  return {
    archive: exported.value.archive,
    manifest: JSON.parse(text(entries.get("manifest.json"))),
    quest: JSON.parse(text(entries.get("quest.json")))
  };
}

function repack(manifestInput, questInput, extras = []) {
  const quest = structuredClone(questInput);
  const manifest = structuredClone(manifestInput);
  const questBytes = jsonBytes(quest);
  manifest.files = [{
    path: "quest.json",
    mediaType: manifest.files?.[0]?.mediaType ?? "application/json",
    byteLength: questBytes.byteLength,
    sha256: sha256(questBytes)
  }];
  const manifestBytes = jsonBytes(manifest);
  const sums = bytes(`${sha256(manifestBytes)}  manifest.json\n${sha256(questBytes)}  quest.json\n`);
  return writeStoredZip([
    { path: "manifest.json", bytes: manifestBytes },
    { path: "quest.json", bytes: questBytes },
    { path: "SHA256SUMS", bytes: sums },
    ...extras
  ]);
}

function jsonBytes(value) { return bytes(`${JSON.stringify(value)}\n`); }
function bytes(value) { return new TextEncoder().encode(value); }
function text(value) { assert.ok(value); return new TextDecoder().decode(value); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function readStoredEntries(archive) {
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= archive.byteLength) {
    const view = new DataView(archive.buffer, archive.byteOffset + offset, archive.byteLength - offset);
    if (view.getUint32(0, true) !== 0x04034b50) break;
    const size = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = new TextDecoder().decode(archive.subarray(nameStart, nameStart + nameLength));
    entries.set(name, archive.slice(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return entries;
}

function centralRecord(archive, path) {
  const endOffset = archive.byteLength - 22;
  const end = new DataView(archive.buffer, archive.byteOffset + endOffset, 22);
  let offset = end.getUint32(16, true);
  const count = end.getUint16(10, true);
  for (let index = 0; index < count; index += 1) {
    const view = new DataView(archive.buffer, archive.byteOffset + offset, archive.byteLength - offset);
    assert.equal(view.getUint32(0, true), 0x02014b50);
    const nameLength = view.getUint16(28, true);
    const extraLength = view.getUint16(30, true);
    const commentLength = view.getUint16(32, true);
    const name = new TextDecoder().decode(archive.subarray(offset + 46, offset + 46 + nameLength));
    if (name === path) return { offset, localOffset: view.getUint32(42, true), nameLength };
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`missing central record ${path}`);
}

function renameEntry(archive, from, to) {
  assert.equal(bytes(from).byteLength, bytes(to).byteLength);
  const changed = archive.slice();
  const record = centralRecord(changed, from);
  const nameBytes = bytes(to);
  changed.set(nameBytes, record.offset + 46);
  const local = new DataView(changed.buffer, changed.byteOffset + record.localOffset, changed.byteLength - record.localOffset);
  assert.equal(local.getUint32(0, true), 0x04034b50);
  changed.set(nameBytes, record.localOffset + 30);
  return changed;
}

async function reason(archive) {
  const result = await parseLhquestDraftPackage(archive);
  assert.equal(result.ok, false);
  return result.code;
}

test("B09-03 import accepts its canonical exported package before hostile mutations", async () => {
  const { archive } = await canonicalPackage();
  const parsed = await parseLhquestDraftPackage(archive);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.sourceQuestId, "q");
  assert.equal(parsed.value.sourceRevision, 0);
});

test("B09-03 import rejects traversal, absolute, NUL and duplicate normalized paths before extraction", async () => {
  const { archive } = await canonicalPackage();
  assert.equal(await reason(renameEntry(archive, "quest.json", "../xx.json")), "UNSAFE_PATH");
  assert.equal(await reason(renameEntry(archive, "quest.json", "/xxxx.json")), "UNSAFE_PATH");
  assert.equal(await reason(renameEntry(archive, "quest.json", "bad\u0000?.json")), "UNSAFE_PATH");
  assert.equal(await reason(renameEntry(archive, "SHA256SUMS", "quest.json")), "DUPLICATE_PATH");
});

test("B09-03 import rejects unsupported ZIP features, symlink-like attrs and declared oversize", async () => {
  const { archive } = await canonicalPackage();

  const method = archive.slice();
  const methodRecord = centralRecord(method, "quest.json");
  new DataView(method.buffer, method.byteOffset + methodRecord.offset, 46).setUint16(10, 8, true);
  assert.equal(await reason(method), "UNSUPPORTED_ZIP_FEATURE");

  const symlink = archive.slice();
  const symlinkRecord = centralRecord(symlink, "quest.json");
  new DataView(symlink.buffer, symlink.byteOffset + symlinkRecord.offset, 46).setUint32(38, 0xa0000000, true);
  assert.equal(await reason(symlink), "UNSUPPORTED_ZIP_FEATURE");

  const hugeMember = archive.slice();
  const hugeRecord = centralRecord(hugeMember, "quest.json");
  const hugeView = new DataView(hugeMember.buffer, hugeMember.byteOffset + hugeRecord.offset, 46);
  hugeView.setUint32(20, MAX_LHQUEST_ENTRY_BYTES + 1, true);
  hugeView.setUint32(24, MAX_LHQUEST_ENTRY_BYTES + 1, true);
  assert.equal(await reason(hugeMember), "FILE_TOO_LARGE");

  const tooMany = archive.slice();
  const end = new DataView(tooMany.buffer, tooMany.byteOffset + tooMany.byteLength - 22, 22);
  end.setUint16(8, 17, true);
  end.setUint16(10, 17, true);
  assert.equal(await reason(tooMany), "TOO_MANY_FILES");

  assert.equal(await reason(new Uint8Array(MAX_LHQUEST_ARCHIVE_BYTES + 1)), "ARCHIVE_TOO_LARGE");
});

test("B09-03 import rejects checksum mismatch, extra executable files and secret-shaped sections", async () => {
  const { archive, manifest, quest } = await canonicalPackage();
  const entries = readStoredEntries(archive);
  const wrongSums = writeStoredZip([
    { path: "manifest.json", bytes: entries.get("manifest.json") },
    { path: "quest.json", bytes: entries.get("quest.json") },
    { path: "SHA256SUMS", bytes: bytes(`${"0".repeat(64)}  manifest.json\n${"0".repeat(64)}  quest.json\n`) }
  ]);
  assert.equal(await reason(wrongSums), "HASH_MISMATCH");

  const executable = repack(manifest, quest, [{ path: "script.html", bytes: bytes("<script>alert(1)</script>") }]);
  assert.equal(await reason(executable), "DISALLOWED_FILE");

  const secretManifest = structuredClone(manifest);
  secretManifest.secrets = { apiKey: "do-not-import" };
  assert.equal(await reason(repack(secretManifest, quest)), "FORBIDDEN_PACKAGE_SECTION");
});

test("B09-03 import rejects incompatible format/schema/plugin requirements and invalid authored refs", async () => {
  const { manifest, quest } = await canonicalPackage();

  const version = structuredClone(manifest);
  version.formatVersion = "999";
  assert.equal(await reason(repack(version, quest)), "UNSUPPORTED_FORMAT_VERSION");

  const schema = structuredClone(manifest);
  schema.compatibility.contractsSchemaVersion = "999";
  assert.equal(await reason(repack(schema, quest)), "UNSUPPORTED_SCHEMA_VERSION");

  const plugin = structuredClone(manifest);
  plugin.compatibility.requiredPlugins = [{ pluginId: "unknown", version: "1.0.0" }];
  assert.equal(await reason(repack(plugin, quest)), "UNSUPPORTED_PLUGIN_REQUIREMENT");

  const broken = structuredClone(quest);
  broken.blocks.find((block) => block.kind === "core.action").data.resourceId = "missing-resource";
  assert.equal(await reason(repack(manifest, broken)), "INVALID_QUEST");
});
