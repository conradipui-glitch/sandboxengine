import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LHQUEST_MEDIA_TYPE,
  MemoryControlStore,
  SQLiteControlStore,
  buildDraftQuestExport
} from "../dist/index.js";

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

async function seed(store) {
  assert.equal((await store.createProject({ projectId: "project", title: "Project" })).kind, "created");
  assert.equal((await store.createQuest({
    projectId: "project", questId: "quest", title: "Original", entryLocationId: "workshop", initialBlocks: [workshop, paint, action]
  })).kind, "created");
  const edited = await store.applyDraftChanges("project", "quest", {
    baseRevision: 0, changes: [{ kind: "quest.title.set", title: "Current changed" }]
  });
  assert.equal(edited.kind, "updated");
}

function readStoredEntries(archive) {
  const entries = new Map();
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 4 <= archive.byteLength) {
    const view = new DataView(archive.buffer, archive.byteOffset + offset, archive.byteLength - offset);
    if (view.getUint32(0, true) !== 0x04034b50) break;
    assert.equal(view.getUint16(8, true), 0);
    const compressed = view.getUint32(18, true);
    const uncompressed = view.getUint32(22, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    assert.equal(compressed, uncompressed);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressed;
    assert.ok(dataEnd <= archive.byteLength);
    const name = decoder.decode(archive.subarray(nameStart, nameStart + nameLength));
    assert.equal(entries.has(name), false);
    entries.set(name, archive.slice(dataStart, dataEnd));
    offset = dataEnd;
  }
  return entries;
}

function text(bytes) {
  return new TextDecoder().decode(bytes);
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function exercise(store) {
  await seed(store);
  const old = await store.getDraftSnapshot("project", "quest", 0);
  const current = await store.getDraft("project", "quest");
  assert.equal(current.draftRevision, 1);
  assert.equal(current.title, "Current changed");

  const first = await buildDraftQuestExport(store, "project", "quest", 0);
  assert.equal(first.kind, "exported");
  assert.equal(first.value.filename, "quest.r0.lhquest.zip");
  assert.equal(first.value.mediaType, LHQUEST_MEDIA_TYPE);
  assert.equal(first.value.manifest.source.draftRevision, 0);
  assert.equal(first.value.manifest.source.contentHash, old.contentHash);
  assert.deepEqual(first.value.manifest.compatibility, {
    contractsSchemaVersion: "1.0", requiredPlugins: []
  });

  const second = await buildDraftQuestExport(store, "project", "quest", 0);
  assert.equal(second.kind, "exported");
  assert.equal(sha256(second.value.archive), sha256(first.value.archive));
  assert.deepEqual(second.value.archive, first.value.archive);

  const entries = readStoredEntries(first.value.archive);
  assert.deepEqual([...entries.keys()].sort(), ["SHA256SUMS", "manifest.json", "quest.json"]);
  const manifestBytes = entries.get("manifest.json");
  const questBytes = entries.get("quest.json");
  const sumsBytes = entries.get("SHA256SUMS");
  assert.ok(manifestBytes && questBytes && sumsBytes);

  const manifest = JSON.parse(text(manifestBytes));
  const quest = JSON.parse(text(questBytes));
  assert.deepEqual(manifest, first.value.manifest);
  assert.equal(quest.sourceQuestId, "quest");
  assert.equal(quest.title, "Original");
  assert.equal(quest.entryLocationId, "workshop");
  assert.deepEqual(quest.blocks, old.blocks);
  assert.equal("projectId" in quest, false);
  assert.equal("draftRevision" in quest, false);

  const sums = text(sumsBytes);
  assert.equal(sums, `${sha256(manifestBytes)}  manifest.json\n${sha256(questBytes)}  quest.json\n`);
  assert.equal(manifest.files[0].sha256, sha256(questBytes));
  assert.equal(manifest.files[0].byteLength, questBytes.byteLength);

  const semanticText = `${text(manifestBytes)}\n${text(questBytes)}`;
  for (const forbidden of ["sessionId", "csrfHash", "tokenHash", "playtestId", "worldSave", "providerPrompt"]) {
    assert.equal(semanticText.includes(forbidden), false);
  }

  assert.deepEqual(await buildDraftQuestExport(store, "project", "quest", 99), {
    kind: "revision_not_found", revision: 99
  });
  assert.deepEqual(await buildDraftQuestExport(store, "project", "missing", 0), { kind: "quest_not_found" });
}

test("B09-03 Memory exact draft export is deterministic, hashed and structurally secret-free", async () => {
  await exercise(new MemoryControlStore());
});

test("B09-03 SQLite exact draft export is deterministic, hashed and structurally secret-free", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-export-"));
  const store = new SQLiteControlStore({ path: join(directory, "control.sqlite") });
  try {
    await exercise(store);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("B09-03 Memory and SQLite produce byte-identical export for equivalent exact snapshots", async () => {
  const memory = new MemoryControlStore();
  const directory = await mkdtemp(join(tmpdir(), "lh-export-parity-"));
  const sqlite = new SQLiteControlStore({ path: join(directory, "control.sqlite") });
  try {
    await seed(memory);
    await seed(sqlite);
    const left = await buildDraftQuestExport(memory, "project", "quest", 0);
    const right = await buildDraftQuestExport(sqlite, "project", "quest", 0);
    assert.equal(left.kind, "exported");
    assert.equal(right.kind, "exported");
    assert.deepEqual(left.value.archive, right.value.archive);
  } finally {
    sqlite.close();
    await rm(directory, { recursive: true, force: true });
  }
});
