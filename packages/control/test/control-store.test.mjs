import test from "node:test";
import assert from "node:assert/strict";
import { MemoryControlStore } from "../dist/index.js";

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

async function createStoreWithQuest(questId = "quest") {
  const store = new MemoryControlStore();
  const project = await store.createProject({ projectId: "project", title: "Проект" });
  assert.equal(project.kind, "created");
  const quest = await store.createQuest({
    projectId: "project",
    questId,
    title: "Тестовый квест",
    entryLocationId: "workshop",
    initialBlocks: [workshop]
  });
  assert.equal(quest.kind, "created");
  return store;
}

function findAction(snapshot) {
  return snapshot.blocks.find((block) => block.kind === "core.action");
}

test("B05-01 stale baseRevision never overwrites a newer draft", async () => {
  const store = await createStoreWithQuest();
  const base = await store.getDraft("project", "quest");
  assert.equal(base.draftRevision, 0);

  const first = await store.applyDraftChanges("project", "quest", {
    baseRevision: 0,
    changes: [{ kind: "quest.title.set", title: "Версия A" }]
  });
  assert.equal(first.kind, "updated");
  assert.equal(first.draft.draftRevision, 1);

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

test("B05-01 invalid multi-change set is all-or-nothing", async () => {
  const store = await createStoreWithQuest();
  const invalid = await store.applyDraftChanges("project", "quest", {
    baseRevision: 0,
    changes: [
      { kind: "block.add", block: bluePaint },
      {
        kind: "block.add",
        block: {
          ...paintAction(1),
          data: { ...paintAction(1).data, resourceId: "missing_resource" }
        }
      }
    ]
  });
  assert.equal(invalid.kind, "invalid_change_set");
  assert.ok(invalid.errors.includes("quest.references"));

  const current = await store.getDraft("project", "quest");
  assert.equal(current.draftRevision, 0);
  assert.deepEqual(current.blocks.map((block) => block.id), ["workshop"]);
});

test("B05-01 referenced resource cannot be removed and draft stays unchanged", async () => {
  const store = await createStoreWithQuest();
  const added = await store.applyDraftChanges("project", "quest", {
    baseRevision: 0,
    changes: [
      { kind: "block.add", block: bluePaint },
      { kind: "block.add", block: paintAction(1) }
    ]
  });
  assert.equal(added.kind, "updated");
  assert.equal(added.draft.draftRevision, 1);

  const removed = await store.applyDraftChanges("project", "quest", {
    baseRevision: 1,
    changes: [{ kind: "block.remove", blockId: "blue_paint" }]
  });
  assert.equal(removed.kind, "invalid_change_set");
  assert.deepEqual(removed.errors, ["change.block_referenced[block:paint:data.resourceId]:0"]);

  const current = await store.getDraft("project", "quest");
  assert.equal(current.draftRevision, 1);
  assert.equal(current.blocks.some((block) => block.id === "blue_paint"), true);
  assert.equal(findAction(current).data.resourceUnitsPerUnit, 1);
});

test("B05-01 validation is bound to exact revision/hash and playtests stay frozen", async () => {
  const store = await createStoreWithQuest();
  const costOne = await store.applyDraftChanges("project", "quest", {
    baseRevision: 0,
    changes: [
      { kind: "block.add", block: bluePaint },
      { kind: "block.add", block: paintAction(1) }
    ]
  });
  assert.equal(costOne.kind, "updated");

  const validationOneResult = await store.validateDraft("project", "quest", 1);
  assert.equal(validationOneResult.kind, "validated");
  const validationOne = validationOneResult.validation;
  assert.equal(validationOne.status, "valid");
  assert.equal(validationOne.contentHash, costOne.draft.contentHash);

  const playtestOneResult = await store.createPlaytest({
    projectId: "project",
    questId: "quest",
    draftRevision: 1,
    validationId: validationOne.validationId
  });
  assert.equal(playtestOneResult.kind, "created");
  const playtestOne = playtestOneResult.playtest;
  assert.equal(findAction(playtestOne.snapshot).data.resourceUnitsPerUnit, 1);

  const costTwo = await store.applyDraftChanges("project", "quest", {
    baseRevision: 1,
    changes: [{ kind: "block.replace", blockId: "paint", block: paintAction(2) }]
  });
  assert.equal(costTwo.kind, "updated");
  assert.equal(costTwo.draft.draftRevision, 2);
  assert.notEqual(costTwo.draft.contentHash, playtestOne.contentHash);

  const staleValidation = await store.createPlaytest({
    projectId: "project",
    questId: "quest",
    draftRevision: 2,
    validationId: validationOne.validationId
  });
  assert.equal(staleValidation.kind, "validation_snapshot_mismatch");

  const validationTwoResult = await store.validateDraft("project", "quest", 2);
  assert.equal(validationTwoResult.kind, "validated");
  assert.equal(validationTwoResult.validation.status, "valid");
  const playtestTwoResult = await store.createPlaytest({
    projectId: "project",
    questId: "quest",
    draftRevision: 2,
    validationId: validationTwoResult.validation.validationId
  });
  assert.equal(playtestTwoResult.kind, "created");

  const restoredOne = await store.getPlaytest(playtestOne.playtestId);
  const restoredTwo = await store.getPlaytest(playtestTwoResult.playtest.playtestId);
  assert.equal(restoredOne.contentHash, playtestOne.contentHash);
  assert.equal(findAction(restoredOne.snapshot).data.resourceUnitsPerUnit, 1);
  assert.equal(findAction(restoredTwo.snapshot).data.resourceUnitsPerUnit, 2);
  assert.notEqual(restoredOne.contentHash, restoredTwo.contentHash);
  assert.equal(Object.isFrozen(restoredOne), true);
  assert.equal(Object.isFrozen(restoredOne.snapshot), true);
  assert.equal(Object.isFrozen(restoredOne.snapshot.blocks), true);
});
