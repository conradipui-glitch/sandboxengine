import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryAuthorAgentJobStore,
  MemoryControlStore
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

function missingOutput() {
  return JSON.stringify({
    explanation: "The requested mechanic is not representable by installed blocks",
    changes: [],
    missingCapabilities: [{
      capabilityId: "mechanic.messenger-return",
      reason: "No installed block or plugin can express the requested trigger"
    }]
  });
}

async function seededStore(questIds = ["quest"]) {
  const store = new MemoryControlStore();
  assert.equal((await store.createProject({ projectId: "p1", title: "Project" })).kind, "created");
  for (const questId of questIds) {
    assert.equal((await store.createQuest({
      projectId: "p1",
      questId,
      title: "Source",
      entryLocationId: "workshop",
      initialBlocks: [workshop]
    })).kind, "created");
  }
  return store;
}

function clock(start = 1000) {
  let value = start;
  return () => value++;
}

function deps(store, jobs, backend, nowMs = clock()) {
  return { store, jobs, backend, profileId: "author-profile", nowMs, backendDeadlineMs: 30_000 };
}

test("B10.a scripted author produces server-bound proposal without mutating draft until explicit apply", async () => {
  const store = await seededStore();
  const jobs = new MemoryAuthorAgentJobStore();
  const backend = new ScriptedAgentBackend({
    backendId: "scripted-author",
    turnSteps: [{ kind: "success", outputText: validOutput(), usage: { inputTokens: 20, outputTokens: 12, totalTokens: 32 } }],
    nowMs: () => 0
  });
  const dependencies = deps(store, jobs, backend);
  const created = await createAuthorAssistantJob(dependencies, {
    jobId: "job-manual", projectId: "p1", questId: "quest", ownerUserId: "owner"
  });
  assert.equal(created.kind, "created");

  const result = await runAuthorAssistantSegment(dependencies, {
    jobId: "job-manual", instruction: "Add a paint action", autoApply: false
  });
  assert.equal(result.kind, "proposal_ready");
  assert.equal(result.job.state, "waiting_user");
  assert.equal(result.proposal.projectId, "p1");
  assert.equal(result.proposal.questId, "quest");
  assert.equal(result.proposal.baseRevision, 0);
  assert.equal(result.proposal.origin.backendId, "scripted-author");
  assert.equal(result.proposal.origin.jobId, "job-manual");
  assert.equal(result.preview.stale, false);
  assert.equal(result.preview.applyAllowed, true);
  assert.equal(result.usage.totalTokens, 32);

  const current = await store.getDraft("p1", "quest");
  assert.equal(current.draftRevision, 0);
  assert.deepEqual(current.blocks.map((block) => block.id), ["workshop"]);

  assert.equal(backend.safeView.capabilities.toolPolicy, "none");
  assert.equal(backend.safeView.capabilities.shell, false);
  assert.equal(backend.safeView.capabilities.filesystem, false);
  assert.equal(backend.safeView.capabilities.repositoryMutation, false);
  assert.equal(backend.safeView.capabilities.externalToolCalls, false);
  assert.equal(backend.capturedTurnRequests.length, 1);
  assert.equal(backend.capturedTurnRequests[0].messages[0].role, "system");
  assert.match(backend.capturedTurnRequests[0].messages[1].content, /Exact quest draft snapshot/);
  assert.doesNotMatch(backend.capturedTurnRequests[0].messages[1].content, /password|csrf|cookie|api[_-]?key/i);
});

test("B10.a explicit autoApply goes through proposal preview/apply and creates exactly one draft revision", async () => {
  const store = await seededStore();
  const jobs = new MemoryAuthorAgentJobStore();
  const backend = new ScriptedAgentBackend({
    backendId: "scripted-author",
    turnSteps: [{ kind: "success", outputText: validOutput() }],
    nowMs: () => 0
  });
  const dependencies = deps(store, jobs, backend);
  assert.equal((await createAuthorAssistantJob(dependencies, {
    jobId: "job-auto", projectId: "p1", questId: "quest", ownerUserId: "owner"
  })).kind, "created");

  const result = await runAuthorAssistantSegment(dependencies, {
    jobId: "job-auto", instruction: "Add paint and apply it", autoApply: true
  });
  assert.equal(result.kind, "applied");
  assert.equal(result.job.state, "succeeded");
  assert.equal(result.draft.draftRevision, 1);
  assert.equal(result.application.resultRevision, 1);
  assert.equal(result.application.origin.jobId, "job-auto");
  assert.deepEqual(result.draft.blocks.map((block) => block.id).sort(), ["paint", "paint-wall", "workshop"]);
  assert.equal((await store.getDraft("p1", "quest")).draftRevision, 1);

  const checkpoints = await jobs.listCheckpoints("job-auto");
  assert.ok(checkpoints.some((entry) => entry.fact.kind === "draft.read"));
  assert.ok(checkpoints.some((entry) => entry.fact.kind === "proposal.produced"));
  assert.ok(checkpoints.some((entry) => entry.fact.kind === "proposal.previewed"));
  assert.ok(checkpoints.some((entry) => entry.fact.kind === "proposal.applied"));
  assert.ok(checkpoints.some((entry) => entry.fact.kind === "job.succeeded"));
});

test("B10.a unknown mechanic becomes missing capability and never invents a fake draft block", async () => {
  const store = await seededStore();
  const jobs = new MemoryAuthorAgentJobStore();
  const backend = new ScriptedAgentBackend({
    backendId: "scripted-author",
    turnSteps: [{ kind: "success", outputText: missingOutput() }],
    nowMs: () => 0
  });
  const dependencies = deps(store, jobs, backend);
  assert.equal((await createAuthorAssistantJob(dependencies, {
    jobId: "job-missing", projectId: "p1", questId: "quest", ownerUserId: "owner"
  })).kind, "created");

  const result = await runAuthorAssistantSegment(dependencies, {
    jobId: "job-missing", instruction: "Make a messenger return automatically", autoApply: true
  });
  assert.equal(result.kind, "proposal_ready");
  assert.equal(result.job.state, "waiting_user");
  assert.equal(result.preview.applyAllowed, false);
  assert.equal(result.preview.candidate, null);
  assert.equal(result.proposal.missingCapabilities[0].capabilityId, "mechanic.messenger-return");
  assert.equal((await store.getDraft("p1", "quest")).draftRevision, 0);
  assert.deepEqual((await store.getDraft("p1", "quest")).blocks.map((block) => block.id), ["workshop"]);
});

test("B10.a malformed backend output fails closed and leaves draft unchanged", async () => {
  const store = await seededStore();
  const jobs = new MemoryAuthorAgentJobStore();
  const backend = new ScriptedAgentBackend({
    backendId: "scripted-author",
    turnSteps: [{ kind: "success", outputText: JSON.stringify({ changes: [] }) }],
    nowMs: () => 0
  });
  const dependencies = deps(store, jobs, backend);
  assert.equal((await createAuthorAssistantJob(dependencies, {
    jobId: "job-malformed", projectId: "p1", questId: "quest", ownerUserId: "owner"
  })).kind, "created");
  const result = await runAuthorAssistantSegment(dependencies, {
    jobId: "job-malformed", instruction: "Do something", autoApply: true
  });
  assert.equal(result.kind, "invalid_backend_output");
  assert.equal(result.job.state, "failed");
  assert.equal((await store.getDraft("p1", "quest")).draftRevision, 0);
});

test("B10.a backend rate limit is surfaced without fallback or draft mutation", async () => {
  const store = await seededStore();
  const jobs = new MemoryAuthorAgentJobStore();
  const backend = new ScriptedAgentBackend({
    backendId: "scripted-author",
    turnSteps: [{ kind: "failure", error: { code: "rate_limited", retryable: true, retryAfterMs: 5000 } }],
    nowMs: () => 0
  });
  const dependencies = deps(store, jobs, backend);
  assert.equal((await createAuthorAssistantJob(dependencies, {
    jobId: "job-rate", projectId: "p1", questId: "quest", ownerUserId: "owner"
  })).kind, "created");
  const result = await runAuthorAssistantSegment(dependencies, {
    jobId: "job-rate", instruction: "Add paint", autoApply: true
  });
  assert.equal(result.kind, "backend_failure");
  assert.equal(result.code, "rate_limited");
  assert.equal(result.job.state, "failed");
  assert.equal(backend.capturedOpenRequests.length, 1);
  assert.equal(backend.capturedTurnRequests.length, 1);
  assert.equal((await store.getDraft("p1", "quest")).draftRevision, 0);
});

test("B10.a concurrent edit during backend turn makes generated proposal stale and blocks overwrite", async () => {
  const store = await seededStore();
  const jobs = new MemoryAuthorAgentJobStore();
  const scripted = new ScriptedAgentBackend({
    backendId: "scripted-author",
    turnSteps: [{ kind: "success", outputText: validOutput() }],
    nowMs: () => 0
  });
  const backend = {
    safeView: scripted.safeView,
    openSession: (request) => scripted.openSession(request),
    closeSession: (request) => scripted.closeSession(request),
    async runTurn(request) {
      const changed = await store.applyDraftChanges("p1", "quest", {
        baseRevision: 0,
        changes: [{ kind: "quest.title.set", title: "Concurrent editor" }]
      });
      assert.equal(changed.kind, "updated");
      return scripted.runTurn(request);
    }
  };
  const dependencies = deps(store, jobs, backend);
  assert.equal((await createAuthorAssistantJob(dependencies, {
    jobId: "job-stale", projectId: "p1", questId: "quest", ownerUserId: "owner"
  })).kind, "created");

  const result = await runAuthorAssistantSegment(dependencies, {
    jobId: "job-stale", instruction: "Add paint", autoApply: true
  });
  assert.equal(result.kind, "proposal_base_conflict");
  assert.equal(result.currentRevision, 1);
  assert.equal(result.job.state, "failed");
  const current = await store.getDraft("p1", "quest");
  assert.equal(current.title, "Concurrent editor");
  assert.deepEqual(current.blocks.map((block) => block.id), ["workshop"]);
});
