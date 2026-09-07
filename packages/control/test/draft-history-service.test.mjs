import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryControlStore,
  SQLiteControlStore,
  analyzeDraftReferences,
  compareDraftRevisions,
  listDraftHistory
} from "../dist/index.js";

const workshop = Object.freeze({
  schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Workshop", description: "", data: Object.freeze({})
});
const yard = Object.freeze({
  schemaVersion: "1.0", id: "yard", kind: "core.location", title: "Yard", description: "", data: Object.freeze({})
});
const paint = Object.freeze({
  schemaVersion: "1.0", id: "paint", kind: "core.resource", title: "Paint", description: "", data: Object.freeze({ unit: "portion", initialValue: 3, min: 0, max: 20 })
});
const paintAction = Object.freeze({
  schemaVersion: "1.0", id: "paint-wall", kind: "core.action", title: "Paint wall", description: "", data: Object.freeze({
    actionType: "core.paint", resourceId: "paint", resourceUnitsPerUnit: 1, durationSecondsPerUnit: 300, allowPartial: true
  })
});

async function seed(store) {
  assert.equal((await store.createProject({ projectId: "project", title: "Project" })).kind, "created");
  assert.equal((await store.createQuest({
    projectId: "project", questId: "quest", title: "Quest", entryLocationId: "workshop",
    initialBlocks: [workshop, yard, paint, paintAction]
  })).kind, "created");
  const r1 = await store.applyDraftChanges("project", "quest", {
    baseRevision: 0,
    changes: [{ kind: "quest.title.set", title: "Quest v1" }]
  });
  assert.equal(r1.kind, "updated");
  const r2 = await store.applyDraftChanges("project", "quest", {
    baseRevision: 1,
    changes: [{
      kind: "block.replace",
      blockId: "paint",
      block: Object.freeze({ ...paint, data: Object.freeze({ ...paint.data, initialValue: 7 }) })
    }]
  });
  assert.equal(r2.kind, "updated");
}

async function runShared(name, createFixture) {
  test(`B09-03 ${name} immutable snapshots expose deterministic history/compare/reference reads`, async () => {
    const fixture = await createFixture();
    try {
      await seed(fixture.store);
      const history = await listDraftHistory(fixture.store, "project", "quest");
      assert.equal(history.kind, "found");
      assert.equal(history.currentRevision, 2);
      assert.deepEqual(history.history.map((entry) => [entry.draftRevision, entry.title, entry.blockCount]), [
        [0, "Quest", 4], [1, "Quest v1", 4], [2, "Quest v1", 4]
      ]);
      assert.equal(Object.isFrozen(history.history), true);

      const comparison = await compareDraftRevisions(fixture.store, "project", "quest", 0, 2);
      assert.equal(comparison.kind, "compared");
      assert.equal(comparison.comparison.titleChanged, true);
      assert.deepEqual(comparison.comparison.replacedBlockIds, ["paint"]);
      assert.deepEqual(comparison.comparison.addedBlockIds, []);
      assert.deepEqual(comparison.comparison.removedBlockIds, []);

      const refs = await analyzeDraftReferences(fixture.store, "project", "quest", 2, "paint");
      assert.equal(refs.kind, "analyzed");
      assert.equal(refs.analysis.safeToDelete, false);
      assert.deepEqual(refs.analysis.references, [
        { sourceKind: "block", sourceId: "paint-wall", path: "data.resourceId", targetBlockId: "paint" }
      ]);

      assert.deepEqual(await compareDraftRevisions(fixture.store, "project", "quest", 0, 99), {
        kind: "revision_not_found", revision: 99
      });
      assert.deepEqual(await listDraftHistory(fixture.store, "project", "missing"), { kind: "quest_not_found" });
    } finally {
      await fixture.close();
    }
  });
}

await runShared("Memory", async () => ({ store: new MemoryControlStore(), close: async () => {} }));

await runShared("SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-b09-history-"));
  const path = join(directory, "control.sqlite");
  const store = new SQLiteControlStore({ path });
  return {
    store,
    close: async () => { store.close(); await rm(directory, { recursive: true, force: true }); }
  };
});

test("B09-03 SQLite draft history remains readable after reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-b09-history-reopen-"));
  const path = join(directory, "control.sqlite");
  let store = new SQLiteControlStore({ path });
  try {
    await seed(store);
    const before = await listDraftHistory(store, "project", "quest");
    store.close();
    store = new SQLiteControlStore({ path });
    const after = await listDraftHistory(store, "project", "quest");
    assert.deepEqual(after, before);
    const old = await store.getDraftSnapshot("project", "quest", 0);
    assert.equal(old.title, "Quest");
    assert.equal(old.blocks.find((block) => block.id === "paint").data.initialValue, 3);
  } finally {
    try { store.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});
