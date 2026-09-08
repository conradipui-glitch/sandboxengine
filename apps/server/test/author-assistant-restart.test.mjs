import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SQLiteAuthorAgentJobStore,
  SQLiteAuthorAgentProposalArtifactStore,
  SQLiteControlStore
} from "../../../packages/control/dist/index.js";
import { ScriptedAgentBackend } from "../../../packages/ai/dist/index.js";
import {
  createAuthorAssistantJob,
  runAuthorAssistantSegment
} from "../dist/author-assistant.js";

const workshop = Object.freeze({
  schemaVersion: "1.0",
  id: "workshop",
  kind: "core.location",
  title: "Workshop",
  description: "",
  data: Object.freeze({})
});
const paint = Object.freeze({
  schemaVersion: "1.0",
  id: "paint",
  kind: "core.resource",
  title: "Paint",
  description: "",
  data: Object.freeze({ unit: "portion", initialValue: 4, min: 0, max: 20 })
});
const action = Object.freeze({
  schemaVersion: "1.0",
  id: "paint-wall",
  kind: "core.action",
  title: "Paint wall",
  description: "",
  data: Object.freeze({
    actionType: "core.paint",
    resourceId: "paint",
    resourceUnitsPerUnit: 1,
    durationSecondsPerUnit: 300,
    allowPartial: true
  })
});

function validOutput() {
  return JSON.stringify({
    explanation: "Add paint and one authored paint action",
    changes: [
      { kind: "block.add", block: paint },
      { kind: "block.add", block: action }
    ],
    missingCapabilities: []
  });
}

function clock(start) {
  let value = start;
  return () => value++;
}

function dependencies(store, jobs, artifacts, backend, nowMs) {
  return {
    store,
    jobs,
    artifacts,
    backend,
    profileId: "author-profile",
    nowMs,
    backendDeadlineMs: 30_000
  };
}

test("B10.a SQLite restart reuses durable proposal artifact without a second backend turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lh-b10-author-restart-"));
  const path = join(dir, "control.sqlite");
  let store1;
  let jobs1;
  let artifacts1;
  let store2;
  let jobs2;
  let artifacts2;
  try {
    store1 = new SQLiteControlStore({ path });
    assert.equal((await store1.createProject({ projectId: "p1", title: "Project" })).kind, "created");
    assert.equal((await store1.createQuest({
      projectId: "p1",
      questId: "quest",
      title: "Source",
      entryLocationId: "workshop",
      initialBlocks: [workshop]
    })).kind, "created");
    jobs1 = new SQLiteAuthorAgentJobStore({ path });
    artifacts1 = new SQLiteAuthorAgentProposalArtifactStore(jobs1, { path });
    const backend1 = new ScriptedAgentBackend({
      backendId: "scripted-author",
      turnSteps: [{
        kind: "success",
        outputText: validOutput(),
        usage: { inputTokens: 20, outputTokens: 12, totalTokens: 32 }
      }],
      nowMs: () => 0
    });
    const firstDeps = dependencies(store1, jobs1, artifacts1, backend1, clock(1_000));
    assert.equal((await createAuthorAssistantJob(firstDeps, {
      jobId: "job-restart",
      projectId: "p1",
      questId: "quest",
      ownerUserId: "owner"
    })).kind, "created");

    const first = await runAuthorAssistantSegment(firstDeps, {
      jobId: "job-restart",
      instruction: "Add a paint action",
      autoApply: false
    });
    assert.equal(first.kind, "proposal_ready");
    assert.equal(first.job.state, "waiting_user");
    assert.equal(first.usage.totalTokens, 32);
    assert.equal(backend1.capturedTurnRequests.length, 1);
    assert.equal((await store1.getDraft("p1", "quest")).draftRevision, 0);
    const firstProposal = first.proposal;

    artifacts1.close(); artifacts1 = null;
    jobs1.close(); jobs1 = null;
    store1.close(); store1 = null;

    store2 = new SQLiteControlStore({ path });
    jobs2 = new SQLiteAuthorAgentJobStore({ path });
    artifacts2 = new SQLiteAuthorAgentProposalArtifactStore(jobs2, { path });
    const backend2 = new ScriptedAgentBackend({
      backendId: "scripted-author",
      turnSteps: [{ kind: "failure", error: { code: "backend_error", retryable: false } }],
      nowMs: () => 0
    });
    const secondDeps = dependencies(store2, jobs2, artifacts2, backend2, clock(5_000));
    const second = await runAuthorAssistantSegment(secondDeps, {
      jobId: "job-restart",
      instruction: "Add a paint action",
      autoApply: false
    });

    assert.equal(second.kind, "proposal_ready");
    assert.equal(second.job.state, "waiting_user");
    assert.deepEqual(second.proposal, firstProposal);
    assert.equal(second.usage.totalTokens, 32);
    assert.equal(backend2.capturedOpenRequests.length, 0);
    assert.equal(backend2.capturedTurnRequests.length, 0);
    assert.equal(backend2.capturedCloseRequests.length, 0);
    assert.equal((await store2.getDraft("p1", "quest")).draftRevision, 0);

    const checkpoints = await jobs2.listCheckpoints("job-restart");
    assert.equal(checkpoints.filter((entry) => entry.fact.kind === "proposal.produced").length, 1);
  } finally {
    try { artifacts2?.close(); } catch {}
    try { jobs2?.close(); } catch {}
    try { store2?.close(); } catch {}
    try { artifacts1?.close(); } catch {}
    try { jobs1?.close(); } catch {}
    try { store1?.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});
