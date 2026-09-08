import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryControlStore, SQLiteControlStore } from "../dist/index.js";
import {
  MemoryAuthoringProposalAuthority,
  SQLiteAuthoringProposalAuthority
} from "../dist/authoring-proposal.js";

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

function paintAction(cost = 1) {
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
  const created = await store.createQuest({
    projectId: "project",
    questId: "quest",
    title: "Тестовый квест",
    entryLocationId: "workshop",
    initialBlocks: [workshop]
  });
  assert.equal(created.kind, "created");
  return created.draft;
}

function proposal(base, overrides = {}) {
  return {
    proposalId: "proposal-1",
    projectId: "project",
    questId: "quest",
    baseRevision: base.draftRevision,
    baseContentHash: base.contentHash,
    explanation: "Добавить ресурс и действие",
    changes: [
      { kind: "quest.title.set", title: "Версия помощника" },
      { kind: "block.add", block: bluePaint },
      { kind: "block.add", block: paintAction(1) }
    ],
    missingCapabilities: [],
    origin: { kind: "assistant", backendId: "scripted-author", jobId: "job-1" },
    ...overrides
  };
}

async function exerciseAuthority(store, authority) {
  const base = await store.getDraft("project", "quest");
  const input = proposal(base);

  const previewOne = await authority.preview(input);
  const previewTwo = await authority.preview(input);
  assert.equal(previewOne.kind, "previewed");
  assert.deepEqual(previewTwo, previewOne);
  assert.equal(previewOne.preview.stale, false);
  assert.equal(previewOne.preview.applyAllowed, true);
  assert.equal(previewOne.preview.candidate.draftRevision, 1);
  assert.equal(previewOne.preview.candidate.title, "Версия помощника");
  assert.deepEqual(previewOne.preview.comparison.addedBlockIds, ["blue_paint", "paint"]);
  assert.equal(previewOne.preview.comparison.titleChanged, true);

  const stillBase = await store.getDraft("project", "quest");
  assert.equal(stillBase.draftRevision, 0);
  assert.equal(stillBase.title, "Тестовый квест");
  assert.deepEqual(stillBase.blocks.map((block) => block.id), ["workshop"]);

  const firstValidation = await store.validateDraft("project", "quest", 0);
  assert.equal(firstValidation.kind, "validated");
  assert.equal(firstValidation.validation.validationId, "validation-1");

  const applied = await authority.apply(input, "apply-1");
  assert.equal(applied.kind, "applied");
  assert.equal(applied.draft.draftRevision, 1);
  assert.equal(applied.draft.contentHash, previewOne.preview.candidate.contentHash);
  assert.deepEqual(applied.application, {
    proposalId: "proposal-1",
    projectId: "project",
    questId: "quest",
    baseRevision: 0,
    baseContentHash: base.contentHash,
    resultRevision: 1,
    resultContentHash: applied.draft.contentHash,
    origin: { kind: "assistant", backendId: "scripted-author", jobId: "job-1" }
  });
  assert.equal(JSON.stringify(applied.application).includes("secret"), false);
  assert.equal(JSON.stringify(applied.application).includes("apply-1"), false);

  const replay = await authority.apply(input, "apply-1");
  assert.equal(replay.kind, "replay");
  assert.deepEqual(replay.draft, applied.draft);
  assert.deepEqual(replay.application, applied.application);

  const changedSameKey = await authority.apply({ ...input, explanation: "Другое объяснение" }, "apply-1");
  assert.deepEqual(changedSameKey, { kind: "idempotency_key_reused" });

  const duplicateDifferentKey = await authority.apply(input, "apply-2");
  assert.equal(duplicateDifferentKey.kind, "revision_conflict");
  assert.equal(duplicateDifferentKey.currentRevision, 1);

  const application = await authority.getApplication("project", "quest", "proposal-1");
  assert.deepEqual(application, applied.application);

  const current = await store.getDraft("project", "quest");
  assert.equal(current.draftRevision, 1);
  assert.deepEqual(current.blocks.map((block) => block.id).sort(), ["blue_paint", "paint", "workshop"]);
}

test("B10.a Memory proposal preview is non-mutating and apply is exact/idempotent", async () => {
  const store = new MemoryControlStore();
  await seed(store);
  const authority = new MemoryAuthoringProposalAuthority(store);
  await exerciseAuthority(store, authority);
});

test("B10.a SQLite proposal preview is non-mutating and apply is exact/idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "lh-b10-proposal-"));
  const path = join(root, "control.sqlite");
  try {
    const store = new SQLiteControlStore({ path });
    await seed(store);
    const authority = new SQLiteAuthoringProposalAuthority(store, { path });
    await exerciseAuthority(store, authority);
    authority.close();
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B10.a stale proposal remains previewable but cannot apply or overwrite", async () => {
  const store = new MemoryControlStore();
  const base = await seed(store);
  const authority = new MemoryAuthoringProposalAuthority(store);
  const input = proposal(base);

  const newer = await store.applyDraftChanges("project", "quest", {
    baseRevision: 0,
    changes: [{ kind: "quest.title.set", title: "Чужая версия" }]
  });
  assert.equal(newer.kind, "updated");

  const preview = await authority.preview(input);
  assert.equal(preview.kind, "previewed");
  assert.equal(preview.preview.stale, true);
  assert.equal(preview.preview.currentRevision, 1);
  assert.equal(preview.preview.applyAllowed, false);
  assert.equal(preview.preview.candidate.title, "Версия помощника");

  const applied = await authority.apply(input, "stale-apply");
  assert.equal(applied.kind, "revision_conflict");
  assert.equal(applied.currentRevision, 1);
  const current = await store.getDraft("project", "quest");
  assert.equal(current.title, "Чужая версия");
  assert.deepEqual(current.blocks.map((block) => block.id), ["workshop"]);
});

test("B10.a invalid references fail preview without touching the real draft", async () => {
  const store = new MemoryControlStore();
  const base = await seed(store);
  const authority = new MemoryAuthoringProposalAuthority(store);
  const input = proposal(base, {
    changes: [{
      kind: "block.add",
      block: {
        ...paintAction(1),
        data: { ...paintAction(1).data, resourceId: "missing_resource" }
      }
    }]
  });

  const preview = await authority.preview(input);
  assert.equal(preview.kind, "invalid_proposal");
  assert.ok(preview.errors.includes("quest.references"));
  const current = await store.getDraft("project", "quest");
  assert.equal(current.draftRevision, 0);
  assert.deepEqual(current.blocks.map((block) => block.id), ["workshop"]);
});

test("B10.a missing capability is explicit and cannot be applied as a fake block", async () => {
  const store = new MemoryControlStore();
  const base = await seed(store);
  const authority = new MemoryAuthoringProposalAuthority(store);
  const input = proposal(base, {
    changes: [],
    missingCapabilities: [{ capabilityId: "mechanic.messenger-return", reason: "No installed block/plugin can express this trigger" }]
  });

  const preview = await authority.preview(input);
  assert.equal(preview.kind, "previewed");
  assert.equal(preview.preview.applyAllowed, false);
  assert.equal(preview.preview.candidate, null);
  assert.equal(preview.preview.missingCapabilities[0].capabilityId, "mechanic.messenger-return");

  const applied = await authority.apply(input, "missing-apply");
  assert.equal(applied.kind, "missing_capability");
  const current = await store.getDraft("project", "quest");
  assert.equal(current.draftRevision, 0);
});

test("B10.a SQLite completed proposal replay survives store/authority reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "lh-b10-proposal-reopen-"));
  const path = join(root, "control.sqlite");
  try {
    let store = new SQLiteControlStore({ path });
    const base = await seed(store);
    let authority = new SQLiteAuthoringProposalAuthority(store, { path });
    const input = proposal(base);
    const applied = await authority.apply(input, "lost-response");
    assert.equal(applied.kind, "applied");
    authority.close();
    store.close();

    store = new SQLiteControlStore({ path });
    authority = new SQLiteAuthoringProposalAuthority(store, { path });
    const replay = await authority.apply(input, "lost-response");
    assert.equal(replay.kind, "replay");
    assert.equal(replay.draft.draftRevision, 1);
    assert.equal(replay.draft.contentHash, applied.draft.contentHash);
    const current = await store.getDraft("project", "quest");
    assert.equal(current.draftRevision, 1);
    assert.equal(current.blocks.filter((block) => block.id === "paint").length, 1);
    assert.deepEqual(await authority.getApplication("project", "quest", "proposal-1"), applied.application);
    authority.close();
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B10.a base content hash mismatch fails closed", async () => {
  const store = new MemoryControlStore();
  const base = await seed(store);
  const authority = new MemoryAuthoringProposalAuthority(store);
  const input = proposal(base, { baseContentHash: "0".repeat(64) });
  const preview = await authority.preview(input);
  assert.equal(preview.kind, "base_snapshot_mismatch");
  assert.equal(preview.revision, 0);
  assert.equal(preview.actualContentHash, base.contentHash);
  const apply = await authority.apply(input, "bad-hash");
  assert.equal(apply.kind, "base_snapshot_mismatch");
  assert.equal((await store.getDraft("project", "quest")).draftRevision, 0);
});
