import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryControlStore,
  SQLiteControlStore
} from "../dist/index.js";

const workshop = {
  schemaVersion: "1.0",
  id: "workshop",
  kind: "core.location",
  title: "Мастерская",
  description: "",
  data: {}
};
const bluePaint = {
  schemaVersion: "1.0",
  id: "blue_paint",
  kind: "core.resource",
  title: "Синяя краска",
  description: "",
  data: { unit: "portion", initialValue: 4, min: 0, max: 20 }
};
const paint = {
  schemaVersion: "1.0",
  id: "paint",
  kind: "core.action",
  title: "Рисовать",
  description: "",
  data: {
    actionType: "core.paint",
    resourceId: "blue_paint",
    resourceUnitsPerUnit: 1,
    durationSecondsPerUnit: 300,
    allowPartial: true
  }
};

async function exercise(store) {
  assert.equal((await store.createProject({ projectId: "p1", title: "Project" })).kind, "created");
  assert.equal((await store.createQuest({
    projectId: "p1",
    questId: "q1",
    title: "Quest",
    entryLocationId: "workshop",
    initialBlocks: [workshop, bluePaint, paint]
  })).kind, "created");

  const referencedResource = await store.applyDraftChanges("p1", "q1", {
    baseRevision: 0,
    changes: [{ kind: "block.remove", blockId: "blue_paint" }]
  });
  assert.equal(referencedResource.kind, "invalid_change_set");
  assert.deepEqual(referencedResource.errors, ["change.block_referenced[block:paint:data.resourceId]:0"]);
  assert.equal((await store.getDraft("p1", "q1")).draftRevision, 0);

  const entryLocation = await store.applyDraftChanges("p1", "q1", {
    baseRevision: 0,
    changes: [{ kind: "block.remove", blockId: "workshop" }]
  });
  assert.equal(entryLocation.kind, "invalid_change_set");
  assert.deepEqual(entryLocation.errors, ["change.block_referenced[quest:q1:entryLocationId]:0"]);
  assert.equal((await store.getDraft("p1", "q1")).draftRevision, 0);

  const atomicRemoval = await store.applyDraftChanges("p1", "q1", {
    baseRevision: 0,
    changes: [
      { kind: "block.remove", blockId: "paint" },
      { kind: "block.remove", blockId: "blue_paint" }
    ]
  });
  assert.equal(atomicRemoval.kind, "updated");
  assert.equal(atomicRemoval.draft.draftRevision, 1);
  assert.deepEqual(atomicRemoval.draft.blocks.map((block) => block.id), ["workshop"]);
}

test("B09-03 Memory deletion reuses typed reference analysis", async () => {
  await exercise(new MemoryControlStore());
});

test("B09-03 SQLite deletion reuses typed reference analysis", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lh-reference-delete-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  try {
    await exercise(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
