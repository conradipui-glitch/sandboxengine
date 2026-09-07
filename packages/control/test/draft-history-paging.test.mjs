import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DRAFT_HISTORY_LIMIT,
  MAX_DRAFT_HISTORY_LIMIT,
  listDraftHistory
} from "../dist/index.js";

function snapshot(revision) {
  return Object.freeze({
    projectId: "p",
    questId: "q",
    draftRevision: revision,
    title: `Revision ${revision}`,
    entryLocationId: "workshop",
    blocks: Object.freeze([Object.freeze({
      schemaVersion: "1.0",
      id: "workshop",
      kind: "core.location",
      title: "Workshop",
      description: "",
      data: Object.freeze({})
    })]),
    contentHash: `hash-${revision}`
  });
}

function fakeStore(lastRevision) {
  return Object.freeze({
    async getDraft(projectId, questId) {
      return projectId === "p" && questId === "q" ? snapshot(lastRevision) : null;
    },
    async getDraftSnapshot(projectId, questId, revision) {
      if (projectId !== "p" || questId !== "q" || revision < 0 || revision > lastRevision) return null;
      return snapshot(revision);
    }
  });
}

test("B09-03 history defaults to newest bounded page and exposes an explicit cursor", async () => {
  assert.equal(DEFAULT_DRAFT_HISTORY_LIMIT, 100);
  assert.equal(MAX_DRAFT_HISTORY_LIMIT, 200);
  const result = await listDraftHistory(fakeStore(249), "p", "q");
  assert.equal(result.kind, "found");
  assert.equal(result.currentRevision, 249);
  assert.equal(result.history.length, 100);
  assert.equal(result.history[0].draftRevision, 150);
  assert.equal(result.history.at(-1).draftRevision, 249);
  assert.equal(result.nextBeforeRevision, 149);
});

test("B09-03 history cursor pages backward without overlap and never exceeds the configured bound", async () => {
  const page = await listDraftHistory(fakeStore(249), "p", "q", { beforeRevision: 149, limit: 100 });
  assert.equal(page.kind, "found");
  assert.equal(page.history.length, 100);
  assert.equal(page.history[0].draftRevision, 50);
  assert.equal(page.history.at(-1).draftRevision, 149);
  assert.equal(page.nextBeforeRevision, 49);

  const oldest = await listDraftHistory(fakeStore(249), "p", "q", { beforeRevision: 49, limit: 100 });
  assert.equal(oldest.kind, "found");
  assert.equal(oldest.history.length, 50);
  assert.equal(oldest.history[0].draftRevision, 0);
  assert.equal(oldest.history.at(-1).draftRevision, 49);
  assert.equal(oldest.nextBeforeRevision, null);

  assert.deepEqual(
    await listDraftHistory(fakeStore(249), "p", "q", { limit: MAX_DRAFT_HISTORY_LIMIT + 1 }),
    { kind: "invalid_request" }
  );
  assert.deepEqual(
    await listDraftHistory(fakeStore(249), "p", "q", { beforeRevision: 250 }),
    { kind: "invalid_request" }
  );
});
