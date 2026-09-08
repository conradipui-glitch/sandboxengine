import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryAuthorAgentJobStore,
  SQLiteAuthorAgentJobStore
} from "../dist/author-agent-jobs.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);

function createInput(overrides = {}) {
  return {
    jobId: "job-1",
    projectId: "p1",
    questId: "q1",
    ownerUserId: "owner",
    startingDraftRevision: 3,
    startingDraftContentHash: HASH_A,
    backendId: "scripted-author",
    allowedOperations: ["draft.read", "proposal.preview", "proposal.apply"],
    maxToolCalls: 2,
    maxActiveTimeMs: 100,
    createdAtMs: 1000,
    ...overrides
  };
}

function assertSafeRecord(value) {
  const text = JSON.stringify(value).toLowerCase();
  for (const forbidden of ["apikey", "api_key", "secret", "csrf", "cookie", "bearer", "password", "progrespercent", "progresspercent"]) {
    assert.equal(text.includes(forbidden), false, `safe job record leaked forbidden key fragment: ${forbidden}`);
  }
}

async function exerciseLifecycle(store) {
  const created = await store.createJob(createInput());
  assert.equal(created.kind, "created");
  assert.equal(created.job.state, "queued");
  assert.equal(created.job.jobVersion, 0);
  assert.equal(created.job.toolCallsUsed, 0);
  assert.equal(created.job.activeTimeMsUsed, 0);
  assert.deepEqual(created.job.grant.allowedOperations, ["draft.read", "proposal.preview", "proposal.apply"]);
  assertSafeRecord(created.job);

  let checkpoints = await store.listCheckpoints("job-1");
  assert.deepEqual(checkpoints.map((item) => item.fact), [{ kind: "job.created" }]);

  const started = await store.transitionJob("job-1", { expectedJobVersion: 0, to: "running", atMs: 1001 });
  assert.equal(started.kind, "updated");
  assert.equal(started.job.state, "running");
  assert.equal(started.job.jobVersion, 1);

  const readReserve = await store.reserveOperation("job-1", {
    expectedJobVersion: 1,
    operationId: "read-1",
    operationKind: "draft.read",
    baseRevision: 3,
    requestHash: HASH_B,
    atMs: 1002
  });
  assert.equal(readReserve.kind, "reserved");
  assert.equal(readReserve.job.jobVersion, 2);
  assert.equal(readReserve.job.toolCallsUsed, 1);
  assert.equal(readReserve.operation.status, "pending");

  const pendingReplay = await store.reserveOperation("job-1", {
    expectedJobVersion: 1,
    operationId: "read-1",
    operationKind: "draft.read",
    baseRevision: 3,
    requestHash: HASH_B,
    atMs: 1002
  });
  assert.equal(pendingReplay.kind, "pending");
  assert.equal(pendingReplay.job.toolCallsUsed, 1);

  const readComplete = await store.completeOperation("job-1", {
    operationId: "read-1",
    requestHash: HASH_B,
    result: { kind: "read_blocks", blockCount: 4 },
    activeTimeMs: 20,
    atMs: 1003
  });
  assert.equal(readComplete.kind, "completed");
  assert.equal(readComplete.job.jobVersion, 3);
  assert.equal(readComplete.job.state, "running");
  assert.equal(readComplete.job.activeTimeMsUsed, 20);
  assert.equal(readComplete.operation.status, "completed");

  const completedReplay = await store.reserveOperation("job-1", {
    expectedJobVersion: 1,
    operationId: "read-1",
    operationKind: "draft.read",
    baseRevision: 3,
    requestHash: HASH_B,
    atMs: 1004
  });
  assert.equal(completedReplay.kind, "replay");
  assert.equal(completedReplay.job.toolCallsUsed, 1);

  const operationReuse = await store.reserveOperation("job-1", {
    expectedJobVersion: 3,
    operationId: "read-1",
    operationKind: "draft.read",
    baseRevision: 3,
    requestHash: HASH_C,
    atMs: 1004
  });
  assert.deepEqual(operationReuse, { kind: "operation_id_reused" });

  const checkpointed = await store.appendCheckpoint("job-1", 3, { kind: "draft.read", blockCount: 4 }, 1004);
  assert.equal(checkpointed.kind, "updated");
  assert.equal(checkpointed.job.jobVersion, 4);

  const applyReserve = await store.reserveOperation("job-1", {
    expectedJobVersion: 4,
    operationId: "apply-1",
    operationKind: "proposal.apply",
    baseRevision: 3,
    requestHash: HASH_C,
    atMs: 1005
  });
  assert.equal(applyReserve.kind, "reserved");
  assert.equal(applyReserve.job.jobVersion, 5);
  assert.equal(applyReserve.job.toolCallsUsed, 2);

  const applyComplete = await store.completeOperation("job-1", {
    operationId: "apply-1",
    requestHash: HASH_C,
    result: { kind: "proposal_applied", proposalId: "proposal-1", resultRevision: 4, resultContentHash: HASH_D },
    activeTimeMs: 30,
    atMs: 1006
  });
  assert.equal(applyComplete.kind, "completed");
  assert.equal(applyComplete.job.state, "paused_budget");
  assert.equal(applyComplete.job.jobVersion, 6);
  assert.equal(applyComplete.job.toolCallsUsed, 2);
  assert.equal(applyComplete.job.activeTimeMsUsed, 50);

  const blockedWhilePaused = await store.reserveOperation("job-1", {
    expectedJobVersion: 6,
    operationId: "blocked-1",
    operationKind: "proposal.preview",
    baseRevision: 4,
    requestHash: HASH_E,
    atMs: 1006
  });
  assert.deepEqual(blockedWhilePaused, { kind: "job_not_runnable", state: "paused_budget" });

  const resumed = await store.transitionJob("job-1", { expectedJobVersion: 6, to: "running", atMs: 1007 });
  assert.equal(resumed.kind, "updated");
  assert.equal(resumed.job.state, "running");
  assert.equal(resumed.job.jobVersion, 7);
  assert.equal(resumed.job.toolCallsUsed, 0);
  assert.equal(resumed.job.activeTimeMsUsed, 0);

  const previewReserve = await store.reserveOperation("job-1", {
    expectedJobVersion: 7,
    operationId: "preview-2",
    operationKind: "proposal.preview",
    baseRevision: 4,
    requestHash: HASH_E,
    atMs: 1008
  });
  assert.equal(previewReserve.kind, "reserved");
  assert.equal(previewReserve.job.jobVersion, 8);
  assert.equal(previewReserve.job.toolCallsUsed, 1);

  const cancelled = await store.transitionJob("job-1", { expectedJobVersion: 8, to: "cancelled", atMs: 1009 });
  assert.equal(cancelled.kind, "updated");
  assert.equal(cancelled.job.state, "cancelled");
  assert.equal(cancelled.job.jobVersion, 9);

  const noNewWork = await store.reserveOperation("job-1", {
    expectedJobVersion: 9,
    operationId: "after-cancel",
    operationKind: "draft.read",
    baseRevision: 4,
    requestHash: HASH_A,
    atMs: 1010
  });
  assert.deepEqual(noNewWork, { kind: "job_not_runnable", state: "cancelled" });

  const finishAlreadyReserved = await store.completeOperation("job-1", {
    operationId: "preview-2",
    requestHash: HASH_E,
    result: { kind: "proposal_previewed", proposalId: "proposal-2", stale: false, applyAllowed: true },
    activeTimeMs: 5,
    atMs: 1010
  });
  assert.equal(finishAlreadyReserved.kind, "completed");
  assert.equal(finishAlreadyReserved.job.state, "cancelled");
  assert.equal(finishAlreadyReserved.job.jobVersion, 10);

  const completeReplay = await store.completeOperation("job-1", {
    operationId: "preview-2",
    requestHash: HASH_E,
    result: { kind: "proposal_previewed", proposalId: "proposal-2", stale: false, applyAllowed: true },
    activeTimeMs: 5,
    atMs: 1011
  });
  assert.equal(completeReplay.kind, "replay");
  assert.equal(completeReplay.job.jobVersion, 10);

  const terminalResume = await store.transitionJob("job-1", { expectedJobVersion: 10, to: "running", atMs: 1012 });
  assert.deepEqual(terminalResume, { kind: "invalid_transition", state: "cancelled" });

  const staleTransition = await store.transitionJob("job-1", { expectedJobVersion: 9, to: "running", atMs: 1012 });
  assert.deepEqual(staleTransition, { kind: "job_version_conflict", currentJobVersion: 10 });

  checkpoints = await store.listCheckpoints("job-1");
  assert.deepEqual(checkpoints.map((item) => item.ordinal), checkpoints.map((_, index) => index));
  assert.deepEqual(checkpoints.map((item) => item.fact.kind), [
    "job.created",
    "job.started",
    "draft.read",
    "budget.paused",
    "job.resumed",
    "job.cancelled"
  ]);
  assert.deepEqual(checkpoints.find((item) => item.fact.kind === "budget.paused").fact, {
    kind: "budget.paused",
    toolCallsUsed: 2,
    activeTimeMsUsed: 50
  });
  assertSafeRecord(checkpoints);
  assertSafeRecord(await store.getJob("job-1"));
}

test("B10.a Memory AuthorAgentJob lifecycle fences replay, budget, resume and cancel", async () => {
  const store = new MemoryAuthorAgentJobStore();
  await exerciseLifecycle(store);
});

test("B10.a SQLite AuthorAgentJob lifecycle fences replay, budget, resume and cancel", async () => {
  const root = mkdtempSync(join(tmpdir(), "lh-b10-agent-job-"));
  const path = join(root, "control.sqlite");
  try {
    const store = new SQLiteAuthorAgentJobStore({ path });
    await exerciseLifecycle(store);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B10.a SQLite AuthorAgentJob pending/completed operation replay survives reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "lh-b10-agent-job-reopen-"));
  const path = join(root, "control.sqlite");
  try {
    let store = new SQLiteAuthorAgentJobStore({ path });
    assert.equal((await store.createJob(createInput({ maxToolCalls: 5 }))).kind, "created");
    assert.equal((await store.transitionJob("job-1", { expectedJobVersion: 0, to: "running", atMs: 1001 })).kind, "updated");
    const reserved = await store.reserveOperation("job-1", {
      expectedJobVersion: 1,
      operationId: "op-reopen",
      operationKind: "proposal.apply",
      baseRevision: 3,
      requestHash: HASH_B,
      atMs: 1002
    });
    assert.equal(reserved.kind, "reserved");
    store.close();

    store = new SQLiteAuthorAgentJobStore({ path });
    const pending = await store.reserveOperation("job-1", {
      expectedJobVersion: 1,
      operationId: "op-reopen",
      operationKind: "proposal.apply",
      baseRevision: 3,
      requestHash: HASH_B,
      atMs: 1003
    });
    assert.equal(pending.kind, "pending");
    assert.equal(pending.job.toolCallsUsed, 1);

    const completed = await store.completeOperation("job-1", {
      operationId: "op-reopen",
      requestHash: HASH_B,
      result: { kind: "proposal_applied", proposalId: "proposal-reopen", resultRevision: 4, resultContentHash: HASH_C },
      activeTimeMs: 12,
      atMs: 1004
    });
    assert.equal(completed.kind, "completed");
    const persisted = await store.getJob("job-1");
    assert.equal(persisted.jobVersion, 3);
    assert.equal(persisted.toolCallsUsed, 1);
    assert.equal(persisted.activeTimeMsUsed, 12);
    store.close();

    store = new SQLiteAuthorAgentJobStore({ path });
    const replay = await store.reserveOperation("job-1", {
      expectedJobVersion: 1,
      operationId: "op-reopen",
      operationKind: "proposal.apply",
      baseRevision: 3,
      requestHash: HASH_B,
      atMs: 1005
    });
    assert.equal(replay.kind, "replay");
    assert.equal(replay.operation.result.resultRevision, 4);
    assert.equal((await store.getJob("job-1")).toolCallsUsed, 1);

    const reused = await store.reserveOperation("job-1", {
      expectedJobVersion: 3,
      operationId: "op-reopen",
      operationKind: "proposal.apply",
      baseRevision: 3,
      requestHash: HASH_D,
      atMs: 1006
    });
    assert.deepEqual(reused, { kind: "operation_id_reused" });
    assertSafeRecord(await store.getJob("job-1"));
    assertSafeRecord(await store.listCheckpoints("job-1"));
    assertSafeRecord(replay.operation);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B10.a author job time budget pauses one segment and explicit resume opens another", async () => {
  const store = new MemoryAuthorAgentJobStore();
  assert.equal((await store.createJob(createInput({ maxToolCalls: 12, maxActiveTimeMs: 25 }))).kind, "created");
  assert.equal((await store.transitionJob("job-1", { expectedJobVersion: 0, to: "running", atMs: 1001 })).kind, "updated");
  const reserve = await store.reserveOperation("job-1", {
    expectedJobVersion: 1,
    operationId: "time-op",
    operationKind: "draft.read",
    baseRevision: 3,
    requestHash: HASH_B,
    atMs: 1002
  });
  assert.equal(reserve.kind, "reserved");
  const complete = await store.completeOperation("job-1", {
    operationId: "time-op",
    requestHash: HASH_B,
    result: { kind: "read_blocks", blockCount: 2 },
    activeTimeMs: 25,
    atMs: 1003
  });
  assert.equal(complete.kind, "completed");
  assert.equal(complete.job.state, "paused_budget");
  assert.equal(complete.job.activeTimeMsUsed, 25);
  const resumed = await store.transitionJob("job-1", { expectedJobVersion: 3, to: "running", atMs: 1004 });
  assert.equal(resumed.kind, "updated");
  assert.equal(resumed.job.activeTimeMsUsed, 0);
  assert.equal(resumed.job.toolCallsUsed, 0);
  const next = await store.reserveOperation("job-1", {
    expectedJobVersion: 4,
    operationId: "time-op-2",
    operationKind: "draft.read",
    baseRevision: 3,
    requestHash: HASH_C,
    atMs: 1005
  });
  assert.equal(next.kind, "reserved");
});

test("B10.a author job capability grant denies ungranted mutation without consuming budget", async () => {
  const store = new MemoryAuthorAgentJobStore();
  assert.equal((await store.createJob(createInput({ allowedOperations: ["draft.read"], maxToolCalls: 2 }))).kind, "created");
  assert.equal((await store.transitionJob("job-1", { expectedJobVersion: 0, to: "running", atMs: 1001 })).kind, "updated");
  const denied = await store.reserveOperation("job-1", {
    expectedJobVersion: 1,
    operationId: "denied",
    operationKind: "proposal.apply",
    baseRevision: 3,
    requestHash: HASH_B,
    atMs: 1002
  });
  assert.deepEqual(denied, { kind: "operation_not_allowed" });
  const job = await store.getJob("job-1");
  assert.equal(job.jobVersion, 1);
  assert.equal(job.toolCallsUsed, 0);
  assert.equal(job.activeTimeMsUsed, 0);
});
