import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryControlStore,
  SQLiteControlStore,
  buildDraftQuestExport
} from "../dist/index.js";

const workshop = Object.freeze({
  schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Workshop", description: "", data: Object.freeze({})
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
    initialBlocks: [workshop, master, paint, action]
  })).kind, "created");
  const edited = await store.applyDraftChanges("project", "source", {
    baseRevision: 0, changes: [{ kind: "quest.title.set", title: "Source exact" }]
  });
  assert.equal(edited.kind, "updated");
  const exported = await buildDraftQuestExport(store, "project", "source", 1);
  assert.equal(exported.kind, "exported");
  return { source: await store.getDraftSnapshot("project", "source", 1), archive: exported.value.archive };
}

async function exercise(name, createFixture) {
  test(`B09-03 ${name} valid export imports as a new independent unpublished draft`, async () => {
    const fixture = await createFixture();
    try {
      const { source, archive } = await seed(fixture.store);
      const result = await fixture.store.importQuestPackage("project", {
        newQuestId: "imported", idempotencyKey: "import-1", archive
      });
      assert.equal(result.kind, "imported");
      assert.equal(result.sourceQuestId, "source");
      assert.equal(result.sourceRevision, 1);
      assert.equal(result.draft.questId, "imported");
      assert.equal(result.draft.draftRevision, 0);
      assert.equal(result.draft.title, source.title);
      assert.equal(result.draft.entryLocationId, source.entryLocationId);
      assert.deepEqual(result.draft.blocks, source.blocks);
      assert.notEqual(result.draft.contentHash, source.contentHash);

      assert.deepEqual(await fixture.store.getDraftSnapshot("project", "source", 1), source);
      assert.equal(await fixture.store.getValidation("validation-999"), null);
      assert.equal(await fixture.store.getPlaytest("playtest-999"), null);

      const changed = await fixture.store.applyDraftChanges("project", "imported", {
        baseRevision: 0, changes: [{ kind: "quest.title.set", title: "Imported edited" }]
      });
      assert.equal(changed.kind, "updated");
      assert.equal((await fixture.store.getDraft("project", "source")).title, "Source exact");
    } finally { await fixture.close(); }
  });

  test(`B09-03 ${name} import retry is idempotent and changed identity cannot reuse the key`, async () => {
    const fixture = await createFixture();
    try {
      const { archive } = await seed(fixture.store);
      const input = { newQuestId: "imported", idempotencyKey: "import-1", archive };
      const first = await fixture.store.importQuestPackage("project", input);
      assert.equal(first.kind, "imported");
      const replay = await fixture.store.importQuestPackage("project", input);
      assert.equal(replay.kind, "replay");
      assert.deepEqual(replay.draft, first.draft);

      const reused = await fixture.store.importQuestPackage("project", {
        newQuestId: "other", idempotencyKey: "import-1", archive
      });
      assert.deepEqual(reused, { kind: "idempotency_key_reused" });
      assert.equal(await fixture.store.getDraft("project", "other"), null);
    } finally { await fixture.close(); }
  });

  test(`B09-03 ${name} invalid package is atomic and does not consume an idempotency key`, async () => {
    const fixture = await createFixture();
    try {
      const { archive } = await seed(fixture.store);
      const invalid = archive.slice();
      invalid[0] ^= 0xff;
      const rejected = await fixture.store.importQuestPackage("project", {
        newQuestId: "bad", idempotencyKey: "import-reusable", archive: invalid
      });
      assert.equal(rejected.kind, "invalid_package");
      assert.equal(await fixture.store.getDraft("project", "bad"), null);

      const accepted = await fixture.store.importQuestPackage("project", {
        newQuestId: "good", idempotencyKey: "import-reusable", archive
      });
      assert.equal(accepted.kind, "imported");
      assert.equal((await fixture.store.getDraft("project", "good")).draftRevision, 0);
    } finally { await fixture.close(); }
  });
}

await exercise("Memory", async () => ({ store: new MemoryControlStore(), close: async () => {} }));
await exercise("SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-import-"));
  const store = new SQLiteControlStore({ path: join(directory, "control.sqlite") });
  return { store, close: async () => { store.close(); await rm(directory, { recursive: true, force: true }); } };
});

test("B09-03 SQLite import idempotency survives reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-import-reopen-"));
  const path = join(directory, "control.sqlite");
  let store = new SQLiteControlStore({ path });
  try {
    const { archive } = await seed(store);
    const input = { newQuestId: "imported", idempotencyKey: "import-reopen", archive };
    const first = await store.importQuestPackage("project", input);
    assert.equal(first.kind, "imported");
    store.close();
    store = new SQLiteControlStore({ path });
    const replay = await store.importQuestPackage("project", input);
    assert.equal(replay.kind, "replay");
    assert.deepEqual(replay.draft, first.draft);
  } finally {
    try { store.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});
