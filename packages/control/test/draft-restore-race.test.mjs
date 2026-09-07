import test from "node:test";
import assert from "node:assert/strict";
import { MemoryControlStore } from "../dist/index.js";

const entry = Object.freeze({
  schemaVersion: "1.0", id: "entry", kind: "core.location", title: "Entry", description: "", data: Object.freeze({})
});

test("B09-03 concurrent identical Memory restore converges on one restored revision and one replay", async () => {
  const store = new MemoryControlStore();
  assert.equal((await store.createProject({ projectId: "project", title: "Project" })).kind, "created");
  assert.equal((await store.createQuest({
    projectId: "project", questId: "quest", title: "Original", entryLocationId: "entry", initialBlocks: [entry]
  })).kind, "created");
  assert.equal((await store.applyDraftChanges("project", "quest", {
    baseRevision: 0, changes: [{ kind: "quest.title.set", title: "Changed" }]
  })).kind, "updated");

  const input = Object.freeze({
    sourceRevision: 0, baseRevision: 1, idempotencyKey: "same", requestHash: "a".repeat(64)
  });
  const [left, right] = await Promise.all([
    store.restoreDraft("project", "quest", input),
    store.restoreDraft("project", "quest", input)
  ]);
  assert.deepEqual([left.kind, right.kind].sort(), ["replay", "restored"]);
  assert.equal(left.draft.draftRevision, 2);
  assert.equal(right.draft.draftRevision, 2);
  assert.deepEqual(left.draft, right.draft);
  assert.equal((await store.getDraft("project", "quest")).draftRevision, 2);
});
