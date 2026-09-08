import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryAuthorAgentJobStore,
  SQLiteAuthorAgentJobStore
} from "../dist/index.js";

const HASH = "a".repeat(64);

async function create(jobs, jobId, ownerUserId, questId, createdAtMs) {
  const result = await jobs.createJob({
    jobId,
    projectId: "p1",
    questId,
    ownerUserId,
    startingDraftRevision: 0,
    startingDraftContentHash: HASH,
    backendId: "scripted-author",
    allowedOperations: ["draft.read", "proposal.preview", "proposal.apply"],
    createdAtMs
  });
  assert.equal(result.kind, "created");
  return result.job;
}

async function shared(jobs) {
  await create(jobs, "old", "editor", "quest", 10);
  const newest = await create(jobs, "new", "editor", "quest", 20);
  await create(jobs, "other-owner", "owner", "quest", 30);
  await create(jobs, "other-quest", "editor", "other", 40);

  const started = await jobs.transitionJob("old", { expectedJobVersion: 0, to: "running", atMs: 50 });
  assert.equal(started.kind, "updated");

  const values = await jobs.listJobs("p1", "quest", "editor");
  assert.deepEqual(values.map((job) => job.jobId), ["old", "new"]);
  assert.equal(values[0].updatedAtMs, 50);
  assert.equal(values[1].createdAtMs, newest.createdAtMs);
  assert.equal(Object.isFrozen(values), true);
  assert.equal(Object.isFrozen(values[0]), true);
}

test("B10.a Memory job discovery is exact-owner/exact-quest and newest-activity first", async () => {
  await shared(new MemoryAuthorAgentJobStore());
});

test("B10.a SQLite job discovery matches Memory and survives reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lh-b10-job-discovery-"));
  const path = join(dir, "control.sqlite");
  let jobs = new SQLiteAuthorAgentJobStore({ path });
  try {
    await shared(jobs);
    jobs.close();
    jobs = new SQLiteAuthorAgentJobStore({ path });
    const values = await jobs.listJobs("p1", "quest", "editor");
    assert.deepEqual(values.map((job) => job.jobId), ["old", "new"]);
    assert.equal(values[0].updatedAtMs, 50);
  } finally {
    try { jobs.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});
