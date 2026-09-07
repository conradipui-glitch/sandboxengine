import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryControlStore,
  SQLiteControlStore,
  analyzeDraftReferences
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

async function exerciseStaleGreenPreflight(store) {
  const yard = {
    schemaVersion: "1.0",
    id: "yard",
    kind: "core.location",
    title: "Двор",
    description: "",
    data: {}
  };
  const visitor = {
    schemaVersion: "1.0",
    id: "visitor",
    kind: "core.character",
    title: "Посетитель",
    description: "",
    data: {
      initialLocationId: "yard",
      initialStatus: "available"
    }
  };

  assert.equal((await store.createProject({ projectId: "preflight", title: "Preflight" })).kind, "created");
  assert.equal((await store.createQuest({
    projectId: "preflight",
    questId: "stale-delete",
    title: "Stale delete",
    entryLocationId: "workshop",
    initialBlocks: [workshop, yard]
  })).kind, "created");

  const preflight = await analyzeDraftReferences(store, "preflight", "stale-delete", 0, "yard");
  assert.equal(preflight.kind, "analyzed");
  assert.equal(preflight.analysis.safeToDelete, true);
  assert.deepEqual(preflight.analysis.references, []);

  const referenced = await store.applyDraftChanges("preflight", "stale-delete", {
    baseRevision: 0,
    changes: [{ kind: "block.add", block: visitor }]
  });
  assert.equal(referenced.kind, "updated");
  assert.equal(referenced.draft.draftRevision, 1);

  const staleDelete = await store.applyDraftChanges("preflight", "stale-delete", {
    baseRevision: 0,
    changes: [{ kind: "block.remove", blockId: "yard" }]
  });
  assert.deepEqual(staleDelete, { kind: "revision_conflict", currentRevision: 1 });
  assert.equal((await store.getDraft("preflight", "stale-delete")).draftRevision, 1);

  const freshDelete = await store.applyDraftChanges("preflight", "stale-delete", {
    baseRevision: 1,
    changes: [{ kind: "block.remove", blockId: "yard" }]
  });
  assert.equal(freshDelete.kind, "invalid_change_set");
  assert.deepEqual(freshDelete.errors, ["change.block_referenced[block:visitor:data.initialLocationId]:0"]);
  const current = await store.getDraft("preflight", "stale-delete");
  assert.equal(current.draftRevision, 1);
  assert.ok(current.blocks.some((block) => block.id === "yard"));
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

test("B09-03 Memory stale green deletion preflight never authorizes deletion", async () => {
  await exerciseStaleGreenPreflight(new MemoryControlStore());
});

test("B09-03 SQLite stale green deletion preflight never authorizes deletion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lh-reference-stale-preflight-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  try {
    await exerciseStaleGreenPreflight(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
