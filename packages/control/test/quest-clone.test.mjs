import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryControlStore, SQLiteControlStore } from "../dist/index.js";

const workshop = Object.freeze({
  schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Workshop", description: "", data: Object.freeze({})
});
const yard = Object.freeze({
  schemaVersion: "1.0", id: "yard", kind: "core.location", title: "Yard", description: "", data: Object.freeze({})
});
const master = Object.freeze({
  schemaVersion: "1.0", id: "master", kind: "core.character", title: "Master", description: "",
  data: Object.freeze({ initialLocationId: "workshop", initialStatus: "available" })
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
    projectId: "project", questId: "source", title: "Source", entryLocationId: "workshop",
    initialBlocks: [workshop, yard, master, paint, action]
  })).kind, "created");
  const edited = await store.applyDraftChanges("project", "source", {
    baseRevision: 0,
    changes: [{ kind: "quest.title.set", title: "Source v1" }]
  });
  assert.equal(edited.kind, "updated");
  return store.getDraftSnapshot("project", "source", 1);
}

function byKind(draft, kind) {
  const block = draft.blocks.find((candidate) => candidate.kind === kind);
  assert.ok(block);
  return block;
}

async function exercise(name, createFixture) {
  test(`B09-03 ${name} clone pins source revision, remaps typed references and stays independent`, async () => {
    const fixture = await createFixture();
    try {
      const source = await seed(fixture.store);
      const result = await fixture.store.cloneQuest("project", "source", {
        newQuestId: "copy", title: "Copy", idempotencyKey: "clone-1"
      });
      assert.equal(result.kind, "cloned");
      assert.equal(result.sourceRevision, 1);
      assert.equal(result.draft.questId, "copy");
      assert.equal(result.draft.draftRevision, 0);
      assert.equal(result.draft.title, "Copy");

      const sourceIds = new Set(source.blocks.map((block) => block.id));
      assert.equal(result.draft.blocks.every((block) => !sourceIds.has(block.id)), true);
      assert.equal(new Set(result.draft.blocks.map((block) => block.id)).size, source.blocks.length);

      const clonedWorkshop = result.draft.blocks.find((block) => block.kind === "core.location" && block.title === "Workshop");
      const clonedMaster = byKind(result.draft, "core.character");
      const clonedPaint = byKind(result.draft, "core.resource");
      const clonedAction = byKind(result.draft, "core.action");
      assert.ok(clonedWorkshop);
      assert.equal(result.draft.entryLocationId, clonedWorkshop.id);
      assert.equal(clonedMaster.data.initialLocationId, clonedWorkshop.id);
      assert.equal(clonedAction.data.resourceId, clonedPaint.id);

      assert.deepEqual(await fixture.store.getDraftSnapshot("project", "source", 1), source);
      const changedCopy = await fixture.store.applyDraftChanges("project", "copy", {
        baseRevision: 0, changes: [{ kind: "quest.title.set", title: "Copy edited" }]
      });
      assert.equal(changedCopy.kind, "updated");
      assert.equal((await fixture.store.getDraft("project", "source")).title, "Source v1");
      assert.equal((await fixture.store.getDraft("project", "source")).draftRevision, 1);
    } finally { await fixture.close(); }
  });

  test(`B09-03 ${name} clone retry is idempotent and changed input cannot reuse the key`, async () => {
    const fixture = await createFixture();
    try {
      await seed(fixture.store);
      const input = { newQuestId: "copy", title: "Copy", idempotencyKey: "clone-1" };
      const first = await fixture.store.cloneQuest("project", "source", input);
      assert.equal(first.kind, "cloned");
      const replay = await fixture.store.cloneQuest("project", "source", input);
      assert.equal(replay.kind, "replay");
      assert.equal(replay.sourceRevision, 1);
      assert.deepEqual(replay.draft, first.draft);

      assert.deepEqual(await fixture.store.cloneQuest("project", "source", {
        newQuestId: "copy", title: "Different", idempotencyKey: "clone-1"
      }), { kind: "idempotency_key_reused" });
      assert.deepEqual(await fixture.store.cloneQuest("project", "source", {
        newQuestId: "other-copy", title: "Copy", idempotencyKey: "clone-1"
      }), { kind: "idempotency_key_reused" });
      assert.equal(await fixture.store.getDraft("project", "other-copy"), null);
    } finally { await fixture.close(); }
  });
}

await exercise("Memory", async () => ({ store: new MemoryControlStore(), close: async () => {} }));
await exercise("SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-clone-"));
  const store = new SQLiteControlStore({ path: join(directory, "control.sqlite") });
  return { store, close: async () => { store.close(); await rm(directory, { recursive: true, force: true }); } };
});

test("B09-03 SQLite clone idempotency and pinned source survive reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-clone-reopen-"));
  const path = join(directory, "control.sqlite");
  let store = new SQLiteControlStore({ path });
  try {
    await seed(store);
    const input = { newQuestId: "copy", title: "Copy", idempotencyKey: "clone-reopen" };
    const first = await store.cloneQuest("project", "source", input);
    assert.equal(first.kind, "cloned");
    const advanced = await store.applyDraftChanges("project", "source", {
      baseRevision: 1, changes: [{ kind: "quest.title.set", title: "Source v2" }]
    });
    assert.equal(advanced.kind, "updated");
    store.close();
    store = new SQLiteControlStore({ path });
    const replay = await store.cloneQuest("project", "source", input);
    assert.equal(replay.kind, "replay");
    assert.equal(replay.sourceRevision, 1);
    assert.deepEqual(replay.draft, first.draft);
    assert.equal((await store.getDraft("project", "source")).draftRevision, 2);
  } finally {
    try { store.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});
