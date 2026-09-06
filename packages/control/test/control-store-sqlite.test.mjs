import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryControlStore, SQLiteControlStore } from "../dist/index.js";

const workshop = Object.freeze({
  schemaVersion: "1.0",
  id: "workshop",
  kind: "core.location",
  title: "Мастерская",
  description: "",
  data: Object.freeze({})
});

const bluePaint = Object.freeze({
  schemaVersion: "1.0",
  id: "blue_paint",
  kind: "core.resource",
  title: "Синяя краска",
  description: "",
  data: Object.freeze({ unit: "portion", initialValue: 4, min: 0, max: 20 })
});

function paintAction(cost) {
  return Object.freeze({
    schemaVersion: "1.0",
    id: "paint",
    kind: "core.action",
    title: "Рисовать",
    description: "",
    data: Object.freeze({
      actionType: "core.paint",
      resourceId: "blue_paint",
      resourceUnitsPerUnit: cost,
      durationSecondsPerUnit: 300,
      allowPartial: true
    })
  });
}

async function seed(store) {
  assert.equal((await store.createProject({ projectId: "project", title: "Проект" })).kind, "created");
  assert.equal((await store.createQuest({
    projectId: "project",
    questId: "quest",
    title: "Тестовый квест",
    entryLocationId: "workshop",
    initialBlocks: [workshop]
  })).kind, "created");
}

function findAction(snapshot) {
  return snapshot.blocks.find((block) => block.kind === "core.action");
}

async function withMemory(run) {
  const store = new MemoryControlStore();
  await run(store);
}

async function withSQLite(run) {
  const dir = await mkdtemp(join(tmpdir(), "living-history-control-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  try {
    await run(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

for (const [name, withStore] of [["Memory", withMemory], ["SQLite", withSQLite]]) {
  test(`B05-01 ${name} shared — stale baseRevision cannot overwrite current draft`, async () => {
    await withStore(async (store) => {
      await seed(store);
      const first = await store.applyDraftChanges("project", "quest", {
        baseRevision: 0,
        changes: [{ kind: "quest.title.set", title: "Версия A" }]
      });
      assert.equal(first.kind, "updated");
      const stale = await store.applyDraftChanges("project", "quest", {
        baseRevision: 0,
        changes: [{ kind: "block.add", block: bluePaint }]
      });
      assert.deepEqual(stale, { kind: "revision_conflict", currentRevision: 1 });
      const current = await store.getDraft("project", "quest");
      assert.equal(current.draftRevision, 1);
      assert.equal(current.title, "Версия A");
      assert.equal(current.blocks.some((block) => block.id === "blue_paint"), false);
    });
  });

  test(`B05-01 ${name} shared — invalid multi-change set is atomic`, async () => {
    await withStore(async (store) => {
      await seed(store);
      const invalid = await store.applyDraftChanges("project", "quest", {
        baseRevision: 0,
        changes: [
          { kind: "block.add", block: bluePaint },
          { kind: "block.add", block: { ...paintAction(1), data: { ...paintAction(1).data, resourceId: "missing_resource" } } }
        ]
      });
      assert.equal(invalid.kind, "invalid_change_set");
      assert.ok(invalid.errors.includes("quest.references"));
      const current = await store.getDraft("project", "quest");
      assert.equal(current.draftRevision, 0);
      assert.deepEqual(current.blocks.map((block) => block.id), ["workshop"]);
    });
  });

  test(`B05-01 ${name} shared — referenced resource cannot be removed`, async () => {
    await withStore(async (store) => {
      await seed(store);
      const added = await store.applyDraftChanges("project", "quest", {
        baseRevision: 0,
        changes: [
          { kind: "block.add", block: bluePaint },
          { kind: "block.add", block: paintAction(1) }
        ]
      });
      assert.equal(added.kind, "updated");
      const removed = await store.applyDraftChanges("project", "quest", {
        baseRevision: 1,
        changes: [{ kind: "block.remove", blockId: "blue_paint" }]
      });
      assert.equal(removed.kind, "invalid_change_set");
      assert.ok(removed.errors.includes("quest.references"));
      const current = await store.getDraft("project", "quest");
      assert.equal(current.draftRevision, 1);
      assert.equal(findAction(current).data.resourceUnitsPerUnit, 1);
    });
  });

  test(`B05-01 ${name} shared — validation and frozen playtests bind exact snapshot hash`, async () => {
    await withStore(async (store) => {
      await seed(store);
      const one = await store.applyDraftChanges("project", "quest", {
        baseRevision: 0,
        changes: [
          { kind: "block.add", block: bluePaint },
          { kind: "block.add", block: paintAction(1) }
        ]
      });
      assert.equal(one.kind, "updated");
      const v1 = await store.validateDraft("project", "quest", 1);
      assert.equal(v1.kind, "validated");
      assert.equal(v1.validation.status, "valid");
      const p1 = await store.createPlaytest({ projectId: "project", questId: "quest", draftRevision: 1, validationId: v1.validation.validationId });
      assert.equal(p1.kind, "created");

      const two = await store.applyDraftChanges("project", "quest", {
        baseRevision: 1,
        changes: [{ kind: "block.replace", blockId: "paint", block: paintAction(2) }]
      });
      assert.equal(two.kind, "updated");
      const mismatch = await store.createPlaytest({ projectId: "project", questId: "quest", draftRevision: 2, validationId: v1.validation.validationId });
      assert.equal(mismatch.kind, "validation_snapshot_mismatch");
      const v2 = await store.validateDraft("project", "quest", 2);
      assert.equal(v2.kind, "validated");
      const p2 = await store.createPlaytest({ projectId: "project", questId: "quest", draftRevision: 2, validationId: v2.validation.validationId });
      assert.equal(p2.kind, "created");

      const restoredOne = await store.getPlaytest(p1.playtest.playtestId);
      const restoredTwo = await store.getPlaytest(p2.playtest.playtestId);
      assert.equal(findAction(restoredOne.snapshot).data.resourceUnitsPerUnit, 1);
      assert.equal(findAction(restoredTwo.snapshot).data.resourceUnitsPerUnit, 2);
      assert.notEqual(restoredOne.contentHash, restoredTwo.contentHash);
      assert.equal(Object.isFrozen(restoredOne.snapshot.blocks), true);
    });
  });
}

test("B05-01 SQLite durable — draft, validation and frozen playtest survive reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-control-restart-"));
  const path = join(dir, "control.sqlite");
  let store = new SQLiteControlStore({ path });
  try {
    await seed(store);
    const one = await store.applyDraftChanges("project", "quest", {
      baseRevision: 0,
      changes: [
        { kind: "block.add", block: bluePaint },
        { kind: "block.add", block: paintAction(1) }
      ]
    });
    assert.equal(one.kind, "updated");
    const validation = await store.validateDraft("project", "quest", 1);
    assert.equal(validation.kind, "validated");
    const playtest = await store.createPlaytest({
      projectId: "project",
      questId: "quest",
      draftRevision: 1,
      validationId: validation.validation.validationId
    });
    assert.equal(playtest.kind, "created");
    const firstHash = playtest.playtest.contentHash;
    const firstPlaytestId = playtest.playtest.playtestId;
    const firstValidationId = validation.validation.validationId;
    store.close();

    store = new SQLiteControlStore({ path });
    const reopenedDraft = await store.getDraft("project", "quest");
    const reopenedValidation = await store.getValidation(firstValidationId);
    const reopenedPlaytest = await store.getPlaytest(firstPlaytestId);
    assert.equal(reopenedDraft.draftRevision, 1);
    assert.equal(reopenedValidation.contentHash, firstHash);
    assert.equal(reopenedPlaytest.contentHash, firstHash);
    assert.equal(findAction(reopenedPlaytest.snapshot).data.resourceUnitsPerUnit, 1);

    const nextValidation = await store.validateDraft("project", "quest", 1);
    assert.equal(nextValidation.kind, "validated");
    assert.notEqual(nextValidation.validation.validationId, firstValidationId);
    const two = await store.applyDraftChanges("project", "quest", {
      baseRevision: 1,
      changes: [{ kind: "block.replace", blockId: "paint", block: paintAction(2) }]
    });
    assert.equal(two.kind, "updated");
    store.close();

    store = new SQLiteControlStore({ path });
    const finalDraft = await store.getDraft("project", "quest");
    const oldPlaytest = await store.getPlaytest(firstPlaytestId);
    assert.equal(finalDraft.draftRevision, 2);
    assert.equal(findAction(finalDraft).data.resourceUnitsPerUnit, 2);
    assert.equal(findAction(oldPlaytest.snapshot).data.resourceUnitsPerUnit, 1);
    assert.equal(oldPlaytest.contentHash, firstHash);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("B05-01 SQLite durable — two independent stores reject stale draft writer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-control-two-store-"));
  const path = join(dir, "control.sqlite");
  const first = new SQLiteControlStore({ path });
  const second = new SQLiteControlStore({ path });
  try {
    await seed(first);
    assert.equal((await first.getDraft("project", "quest")).draftRevision, 0);
    assert.equal((await second.getDraft("project", "quest")).draftRevision, 0);

    const committed = await first.applyDraftChanges("project", "quest", {
      baseRevision: 0,
      changes: [{ kind: "quest.title.set", title: "Победившая версия" }]
    });
    assert.equal(committed.kind, "updated");

    const stale = await second.applyDraftChanges("project", "quest", {
      baseRevision: 0,
      changes: [{ kind: "quest.title.set", title: "Потерянное обновление" }]
    });
    assert.deepEqual(stale, { kind: "revision_conflict", currentRevision: 1 });
    const current = await second.getDraft("project", "quest");
    assert.equal(current.draftRevision, 1);
    assert.equal(current.title, "Победившая версия");
  } finally {
    first.close();
    second.close();
    await rm(dir, { recursive: true, force: true });
  }
});
