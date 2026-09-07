import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryControlStore, SQLiteControlStore } from "../dist/index.js";

function location(id) {
  return Object.freeze({ schemaVersion: "1.0", id, kind: "core.location", title: id, description: "", data: Object.freeze({}) });
}

async function seed(store, blockCount = 3) {
  const blocks = Array.from({ length: blockCount }, (_, index) => location(index === 0 ? "entry" : `location-${index}`));
  assert.equal((await store.createProject({ projectId: "project", title: "Project" })).kind, "created");
  assert.equal((await store.createQuest({
    projectId: "project", questId: "quest", title: "Original", entryLocationId: "entry", initialBlocks: blocks
  })).kind, "created");
  const validated0 = await store.validateDraft("project", "quest", 0);
  assert.equal(validated0.kind, "validated");
  const edited = await store.applyDraftChanges("project", "quest", {
    baseRevision: 0,
    changes: [{ kind: "quest.title.set", title: "Changed" }]
  });
  assert.equal(edited.kind, "updated");
  return { source: await store.getDraftSnapshot("project", "quest", 0), validation0: validated0.validation };
}

function restoreInput(overrides = {}) {
  return Object.freeze({
    sourceRevision: 0,
    baseRevision: 1,
    idempotencyKey: "restore-1",
    requestHash: "a".repeat(64),
    ...overrides
  });
}

async function shared(name, createFixture) {
  test(`B09-03 ${name} restore creates a new revision from exact old content and preserves old records`, async () => {
    const fixture = await createFixture();
    try {
      const { source, validation0 } = await seed(fixture.store);
      const result = await fixture.store.restoreDraft("project", "quest", restoreInput());
      assert.equal(result.kind, "restored");
      assert.equal(result.draft.draftRevision, 2);
      assert.equal(result.draft.title, "Original");
      assert.equal(result.draft.contentHash, source.contentHash);
      assert.deepEqual(result.draft.blocks, source.blocks);

      const old = await fixture.store.getDraftSnapshot("project", "quest", 0);
      assert.deepEqual(old, source);
      const validationAfter = await fixture.store.getValidation(validation0.validationId);
      assert.deepEqual(validationAfter, validation0);
      assert.equal(validationAfter.draftRevision, 0);

      const history1 = await fixture.store.getDraftSnapshot("project", "quest", 1);
      assert.equal(history1.title, "Changed");
      assert.equal((await fixture.store.getDraft("project", "quest")).draftRevision, 2);
    } finally { await fixture.close(); }
  });

  test(`B09-03 ${name} restore is idempotent and stale base cannot overwrite newer draft`, async () => {
    const fixture = await createFixture();
    try {
      await seed(fixture.store);
      const first = await fixture.store.restoreDraft("project", "quest", restoreInput());
      assert.equal(first.kind, "restored");
      const replay = await fixture.store.restoreDraft("project", "quest", restoreInput());
      assert.equal(replay.kind, "replay");
      assert.deepEqual(replay.draft, first.draft);
      assert.equal((await fixture.store.getDraft("project", "quest")).draftRevision, 2);

      assert.deepEqual(await fixture.store.restoreDraft("project", "quest", restoreInput({ requestHash: "b".repeat(64) })), {
        kind: "idempotency_key_reused"
      });
      assert.equal((await fixture.store.getDraft("project", "quest")).draftRevision, 2);

      const stale = await fixture.store.restoreDraft("project", "quest", restoreInput({
        baseRevision: 1,
        idempotencyKey: "restore-stale",
        requestHash: "c".repeat(64)
      }));
      assert.deepEqual(stale, { kind: "revision_conflict", currentRevision: 2 });
      assert.equal((await fixture.store.getDraft("project", "quest")).draftRevision, 2);
    } finally { await fixture.close(); }
  });
}

await shared("Memory", async () => ({ store: new MemoryControlStore(), close: async () => {} }));
await shared("SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-b09-restore-"));
  const path = join(directory, "control.sqlite");
  const store = new SQLiteControlStore({ path });
  return { store, close: async () => { store.close(); await rm(directory, { recursive: true, force: true }); } };
});

test("B09-03 restore is snapshot-level and works for drafts larger than normal 100-change batch", async () => {
  const store = new MemoryControlStore();
  const { source } = await seed(store, 151);
  const restored = await store.restoreDraft("project", "quest", restoreInput());
  assert.equal(restored.kind, "restored");
  assert.equal(restored.draft.blocks.length, 151);
  assert.equal(restored.draft.contentHash, source.contentHash);
});

test("B09-03 SQLite restore idempotency survives reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-b09-restore-reopen-"));
  const path = join(directory, "control.sqlite");
  let store = new SQLiteControlStore({ path });
  try {
    await seed(store);
    const first = await store.restoreDraft("project", "quest", restoreInput());
    assert.equal(first.kind, "restored");
    store.close();
    store = new SQLiteControlStore({ path });
    const replay = await store.restoreDraft("project", "quest", restoreInput());
    assert.equal(replay.kind, "replay");
    assert.deepEqual(replay.draft, first.draft);
    assert.equal((await store.getDraft("project", "quest")).draftRevision, 2);
  } finally {
    try { store.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});

test("B09-03 two SQLite writers cannot both restore from the same base revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-b09-restore-race-"));
  const path = join(directory, "control.sqlite");
  const firstStore = new SQLiteControlStore({ path });
  const secondStore = new SQLiteControlStore({ path });
  try {
    await seed(firstStore);
    const first = await firstStore.restoreDraft("project", "quest", restoreInput({ idempotencyKey: "winner", requestHash: "d".repeat(64) }));
    assert.equal(first.kind, "restored");
    const second = await secondStore.restoreDraft("project", "quest", restoreInput({ idempotencyKey: "loser", requestHash: "e".repeat(64) }));
    assert.deepEqual(second, { kind: "revision_conflict", currentRevision: 2 });
  } finally {
    firstStore.close(); secondStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});
