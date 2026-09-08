import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryAuthorAgentJobStore,
  SQLiteAuthorAgentJobStore
} from "../dist/author-agent-jobs.js";
import {
  AUTHOR_TOOL_BROKER_POLICY_HASH,
  AUTHOR_TOOL_BROKER_POLICY_VERSION,
  authorizeAuthorToolBrokerRequest,
  ensureAuthorToolBrokerPin
} from "../dist/author-tool-broker.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function createInput(jobId = "job-broker") {
  return {
    jobId,
    projectId: "p1",
    questId: "q1",
    ownerUserId: "owner",
    startingDraftRevision: 2,
    startingDraftContentHash: HASH_A,
    backendId: "scripted-author",
    allowedOperations: ["draft.read", "proposal.preview", "proposal.apply"],
    maxToolCalls: 12,
    maxActiveTimeMs: 120000,
    createdAtMs: 1000
  };
}

async function runningJob(store, jobId = "job-broker") {
  const created = await store.createJob(createInput(jobId));
  assert.equal(created.kind, "created");
  const started = await store.transitionJob(jobId, { expectedJobVersion: 0, to: "running", atMs: 1001 });
  assert.equal(started.kind, "updated");
  return started.job;
}

test("B10.b.11 broker pins server policy and third-party Skill/MCP text cannot grant forbidden authority", async () => {
  const store = new MemoryAuthorAgentJobStore();
  let job = await runningJob(store);
  const pinned = await ensureAuthorToolBrokerPin(store, job, HASH_A, 1002);
  assert.equal(pinned.kind, "pinned");
  assert.equal(pinned.newlyPinned, true);
  job = pinned.job;
  assert.equal(pinned.pin.policyVersion, AUTHOR_TOOL_BROKER_POLICY_VERSION);
  assert.equal(pinned.pin.policyHash, AUTHOR_TOOL_BROKER_POLICY_HASH);
  assert.equal(pinned.pin.installedDocsHash, HASH_A);
  assert.deepEqual(pinned.pin.allowedToolIds, [
    "author.draft.read",
    "author.proposal.apply",
    "author.proposal.preview",
    "docs.agent-kit.read"
  ]);
  assert.equal(Object.isFrozen(pinned.pin), true);
  assert.equal(Object.isFrozen(pinned.pin.allowedToolIds), true);

  const safeSkill = authorizeAuthorToolBrokerRequest(pinned.pin, job, {
    toolId: "author.draft.read", source: "skill"
  });
  assert.deepEqual(safeSkill, {
    kind: "allowed", toolId: "author.draft.read", source: "skill", operationKind: "draft.read"
  });

  for (const [toolId, source] of [
    ["shell.exec", "skill"],
    ["filesystem.read", "mcp"],
    ["repository.write", "skill"],
    ["code.execute", "mcp"],
    ["deployment.run", "skill"],
    ["secret.read", "mcp"]
  ]) {
    const denied = authorizeAuthorToolBrokerRequest(pinned.pin, job, { toolId, source, transportAvailable: true });
    assert.equal(denied.kind, "denied");
    assert.equal(denied.code, "tool_not_allowed");
  }

  const offline = authorizeAuthorToolBrokerRequest(pinned.pin, job, {
    toolId: "docs.agent-kit.read", source: "mcp", transportAvailable: false
  });
  assert.deepEqual(offline, {
    kind: "unavailable",
    code: "mcp_unavailable",
    toolId: "docs.agent-kit.read",
    fallback: { source: "builtin", toolId: "docs.agent-kit.read" }
  });
  const explicitFallback = authorizeAuthorToolBrokerRequest(pinned.pin, job, offline.fallback);
  assert.equal(explicitFallback.kind, "allowed");
  assert.equal(explicitFallback.source, "builtin");

  const checkpoints = await store.listCheckpoints(job.jobId);
  const brokerFacts = checkpoints.filter((entry) => entry.fact.kind === "broker.pinned");
  assert.equal(brokerFacts.length, 1);
  assert.equal(brokerFacts[0].fact.contractHash, pinned.pin.contractHash);

  const same = await ensureAuthorToolBrokerPin(store, job, HASH_A, 1003);
  assert.equal(same.kind, "pinned");
  assert.equal(same.newlyPinned, false);
  assert.equal(same.pin.contractHash, pinned.pin.contractHash);

  const changedSkill = await ensureAuthorToolBrokerPin(store, job, HASH_B, 1004);
  assert.equal(changedSkill.kind, "pinned_mismatch");
  assert.equal(changedSkill.pin.installedDocsHash, HASH_A);
  assert.equal(changedSkill.currentPin.installedDocsHash, HASH_B);
  assert.equal((await store.listCheckpoints(job.jobId)).filter((entry) => entry.fact.kind === "broker.pinned").length, 1);
});

test("B10.b.11 broker pin survives SQLite reopen and does not silently adopt a new docs/Skill hash", async () => {
  const root = mkdtempSync(join(tmpdir(), "lh-b10-broker-"));
  const path = join(root, "control.sqlite");
  try {
    let store = new SQLiteAuthorAgentJobStore({ path });
    let job = await runningJob(store, "job-sqlite-broker");
    const first = await ensureAuthorToolBrokerPin(store, job, HASH_A, 1002);
    assert.equal(first.kind, "pinned");
    assert.equal(first.newlyPinned, true);
    const contractHash = first.pin.contractHash;
    store.close();

    store = new SQLiteAuthorAgentJobStore({ path });
    job = await store.getJob("job-sqlite-broker");
    assert.ok(job);
    const reopened = await ensureAuthorToolBrokerPin(store, job, HASH_A, 1003);
    assert.equal(reopened.kind, "pinned");
    assert.equal(reopened.newlyPinned, false);
    assert.equal(reopened.pin.contractHash, contractHash);

    const changed = await ensureAuthorToolBrokerPin(store, reopened.job, HASH_B, 1004);
    assert.equal(changed.kind, "pinned_mismatch");
    assert.equal(changed.pin.contractHash, contractHash);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B10.b.11 broker never widens a reduced job grant", async () => {
  const store = new MemoryAuthorAgentJobStore();
  const created = await store.createJob({ ...createInput("job-read-only"), allowedOperations: ["draft.read"] });
  assert.equal(created.kind, "created");
  const started = await store.transitionJob("job-read-only", { expectedJobVersion: 0, to: "running", atMs: 1001 });
  assert.equal(started.kind, "updated");
  const pinned = await ensureAuthorToolBrokerPin(store, started.job, HASH_A, 1002);
  assert.equal(pinned.kind, "pinned");
  assert.deepEqual(pinned.pin.allowedToolIds, ["author.draft.read", "docs.agent-kit.read"]);
  const deniedApply = authorizeAuthorToolBrokerRequest(pinned.pin, pinned.job, {
    toolId: "author.proposal.apply", source: "skill"
  });
  assert.equal(deniedApply.kind, "denied");
  assert.equal(deniedApply.code, "job_grant_required");
});
