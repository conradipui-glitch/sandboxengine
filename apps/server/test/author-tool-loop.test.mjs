import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryAuthorAgentJobStore,
  MemoryAuthorAgentProposalArtifactStore,
  MemoryControlStore,
  SQLiteAuthorAgentJobStore
} from "../../../packages/control/dist/index.js";
import { ScriptedAgentBackend } from "../../../packages/ai/dist/index.js";
import { createAuthorAssistantJob } from "../dist/author-assistant.js";
import { createAuthorReferenceToolBridge } from "../dist/author-tool-loop.js";

const HASH = "a".repeat(64);
const workshop = Object.freeze({
  schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Workshop", description: "", data: Object.freeze({})
});

function mcpClient({ available = true, output = { text: "versioned docs" } } = {}) {
  const calls = [];
  return {
    calls,
    safeView: Object.freeze({
      connectionId: "context7-main",
      serverId: "context7",
      transport: "stdio",
      version: "1.0.0",
      credentialRefId: null,
      available,
      tools: Object.freeze([{ externalToolName: "resolve-library-docs", brokerToolId: "docs.reference.read" }])
    }),
    async callTool(request) {
      calls.push(request);
      return { ok: true, output };
    }
  };
}

async function seededControlStore() {
  const store = new MemoryControlStore();
  assert.equal((await store.createProject({ projectId: "p1", title: "P" })).kind, "created");
  assert.equal((await store.createQuest({
    projectId: "p1", questId: "q1", title: "Q", entryLocationId: "workshop", initialBlocks: [workshop]
  })).kind, "created");
  return store;
}

function assistantDeps(store, jobs, client) {
  return {
    store,
    jobs,
    artifacts: new MemoryAuthorAgentProposalArtifactStore(jobs),
    backend: new ScriptedAgentBackend({ backendId: "scripted-author", nowMs: () => 0 }),
    profileId: "author-profile",
    ...(client ? { referenceMcpClient: client } : {}),
    nowMs: (() => { let value = 1000; return () => value++; })()
  };
}

async function createRunningJob(store, jobId = "job-ref", maxToolCalls = 4) {
  const created = await store.createJob({
    jobId,
    projectId: "p1",
    questId: "q1",
    ownerUserId: "owner",
    startingDraftRevision: 0,
    startingDraftContentHash: HASH,
    backendId: "scripted-author",
    allowedOperations: ["draft.read", "proposal.preview", "proposal.apply", "docs.reference.read"],
    maxToolCalls,
    maxActiveTimeMs: 120000,
    createdAtMs: 1000
  });
  assert.equal(created.kind, "created");
  const started = await store.transitionJob(jobId, { expectedJobVersion: 0, to: "running", atMs: 1001 });
  assert.equal(started.kind, "updated");
  return started.job;
}

test("B10.b.11 configured author job grants reference read only when MCP reference client exists", async () => {
  const store = await seededControlStore();
  const jobsA = new MemoryAuthorAgentJobStore();
  const client = mcpClient();
  const withMcp = await createAuthorAssistantJob(assistantDeps(store, jobsA, client), {
    jobId: "job-with-mcp", projectId: "p1", questId: "q1", ownerUserId: "owner"
  });
  assert.equal(withMcp.kind, "created");
  assert.deepEqual(withMcp.job.grant.allowedOperations, [
    "draft.read", "proposal.preview", "proposal.apply", "docs.reference.read"
  ]);

  const jobsB = new MemoryAuthorAgentJobStore();
  const withoutMcp = await createAuthorAssistantJob(assistantDeps(store, jobsB, null), {
    jobId: "job-no-mcp", projectId: "p1", questId: "q1", ownerUserId: "owner"
  });
  assert.equal(withoutMcp.kind, "created");
  assert.deepEqual(withoutMcp.job.grant.allowedOperations, ["draft.read", "proposal.preview", "proposal.apply"]);
});

test("B10.b.11 bridge exposes one read tool, journals it, and exact retry replays without a second MCP call", async () => {
  const jobs = new MemoryAuthorAgentJobStore();
  await createRunningJob(jobs);
  const client = mcpClient({ output: { docs: ["v5 API"] } });
  let tick = 2000;
  const bridge = createAuthorReferenceToolBridge({ jobs, client, nowMs: () => tick++ }, "job-ref");
  assert.deepEqual(bridge.safeView.toolIds, ["docs.reference.read"]);
  assert.equal(bridge.safeView.shell, false);
  assert.equal(bridge.safeView.filesystem, false);
  assert.equal(bridge.safeView.repositoryMutation, false);
  assert.equal(bridge.safeView.codeExecution, false);
  assert.equal(bridge.safeView.deployment, false);
  assert.equal(bridge.safeView.secretRead, false);

  const input = { operationId: "docs-1", query: "How does API v5 work?", targetVersion: "5.0.0" };
  const first = await bridge.readReference(input);
  assert.equal(first.kind, "completed");
  assert.equal(first.replay, false);
  assert.deepEqual(first.output, { docs: ["v5 API"] });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].arguments.targetVersion, "5.0.0");
  assert.equal(first.job.toolCallsUsed, 1);

  const replay = await bridge.readReference(input);
  assert.equal(replay.kind, "completed");
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.output, first.output);
  assert.equal(client.calls.length, 1);
  assert.equal(replay.job.toolCallsUsed, 1);

  const changed = await bridge.readReference({ ...input, query: "Different query" });
  assert.equal(changed.kind, "denied");
  assert.equal(changed.code, "operation_id_reused");
  assert.equal(client.calls.length, 1);
});

test("B10.b.11 offline MCP result is durable, budgeted and replayed without implicit fallback", async () => {
  const jobs = new MemoryAuthorAgentJobStore();
  await createRunningJob(jobs, "job-offline", 2);
  const client = mcpClient({ available: false });
  let tick = 3000;
  const bridge = createAuthorReferenceToolBridge({ jobs, client, nowMs: () => tick++ }, "job-offline");
  const input = { operationId: "offline-1", query: "Need exact dependency docs", targetVersion: "4.2.0" };

  const first = await bridge.readReference(input);
  assert.equal(first.kind, "unavailable");
  assert.equal(first.code, "mcp_offline");
  assert.equal(first.replay, false);
  assert.equal(first.job.toolCallsUsed, 1);
  assert.equal(client.calls.length, 0);

  const replay = await bridge.readReference(input);
  assert.equal(replay.kind, "unavailable");
  assert.equal(replay.code, "mcp_offline");
  assert.equal(replay.replay, true);
  assert.equal(replay.job.toolCallsUsed, 1);
  assert.equal(client.calls.length, 0);
});

test("B10.b.11 completed reference operation survives SQLite reopen and replays exact output", async () => {
  const root = mkdtempSync(join(tmpdir(), "lh-b10-ref-tool-"));
  const path = join(root, "control.sqlite");
  try {
    let jobs = new SQLiteAuthorAgentJobStore({ path });
    await createRunningJob(jobs, "job-sqlite-ref", 4);
    const clientA = mcpClient({ output: { answer: "pinned 2.1 docs" } });
    let tick = 4000;
    let bridge = createAuthorReferenceToolBridge({ jobs, client: clientA, nowMs: () => tick++ }, "job-sqlite-ref");
    const input = { operationId: "sqlite-docs-1", query: "Pinned API", targetVersion: "2.1.0" };
    const first = await bridge.readReference(input);
    assert.equal(first.kind, "completed");
    assert.equal(first.replay, false);
    assert.equal(clientA.calls.length, 1);
    jobs.close();

    jobs = new SQLiteAuthorAgentJobStore({ path });
    const clientB = mcpClient({ output: { answer: "SHOULD NOT BE CALLED" } });
    bridge = createAuthorReferenceToolBridge({ jobs, client: clientB, nowMs: () => tick++ }, "job-sqlite-ref");
    const replay = await bridge.readReference(input);
    assert.equal(replay.kind, "completed");
    assert.equal(replay.replay, true);
    assert.deepEqual(replay.output, { answer: "pinned 2.1 docs" });
    assert.equal(clientB.calls.length, 0);
    assert.equal(replay.job.toolCallsUsed, 1);
    jobs.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B10.b.11 a job without docs.reference.read grant is denied before MCP transport", async () => {
  const jobs = new MemoryAuthorAgentJobStore();
  const created = await jobs.createJob({
    jobId: "job-no-ref",
    projectId: "p1",
    questId: "q1",
    ownerUserId: "owner",
    startingDraftRevision: 0,
    startingDraftContentHash: HASH,
    backendId: "scripted-author",
    allowedOperations: ["draft.read"],
    createdAtMs: 5000
  });
  assert.equal(created.kind, "created");
  assert.equal((await jobs.transitionJob("job-no-ref", { expectedJobVersion: 0, to: "running", atMs: 5001 })).kind, "updated");
  const client = mcpClient();
  const bridge = createAuthorReferenceToolBridge({ jobs, client, nowMs: () => 5002 }, "job-no-ref");
  const result = await bridge.readReference({ operationId: "denied-ref", query: "docs", targetVersion: null });
  assert.equal(result.kind, "denied");
  assert.equal(result.code, "broker_denied");
  assert.equal(client.calls.length, 0);
});
