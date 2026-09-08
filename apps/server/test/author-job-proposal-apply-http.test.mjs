import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryAuthorAgentJobStore,
  MemoryAuthorAgentProposalArtifactStore,
  MemoryAuthorConversationStore,
  MemoryControlSecurityStore,
  MemoryControlStore
} from "../../../packages/control/dist/index.js";
import { ScriptedAgentBackend } from "../../../packages/ai/dist/index.js";
import { createControlHttpServer } from "../dist/control-server.js";

const ORIGIN = "https://studio.example";
const workshop = { schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Workshop", description: "", data: {} };
const paint = { schemaVersion: "1.0", id: "paint", kind: "core.resource", title: "Paint", description: "", data: { unit: "portion", initialValue: 4, min: 0, max: 20 } };

function output() {
  return JSON.stringify({ explanation: "Add paint", changes: [{ kind: "block.add", block: paint }], missingCapabilities: [] });
}
async function request(base, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  let body;
  if (Object.hasOwn(options, "json")) { headers["content-type"] = "application/json"; body = JSON.stringify(options.json); }
  const response = await fetch(`${base}${path}`, { method: options.method ?? "GET", headers, body });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
function clock(start = 1000) { let value = start; return () => value++; }
async function setup() {
  const store = new MemoryControlStore();
  const security = new MemoryControlSecurityStore(store);
  assert.equal((await security.provisionUser({ userId: "editor", username: "editor.user", password: "editor password 123" })).kind, "created");
  assert.equal((await security.provisionUser({ userId: "owner", username: "owner.user", password: "owner password 123" })).kind, "created");
  assert.equal((await security.createProjectAsOwner({ projectId: "p1", title: "Project" }, "owner")).kind, "created");
  assert.equal((await security.setProjectMemberRole("p1", "editor", "editor")).kind, "updated");
  assert.equal((await store.createQuest({ projectId: "p1", questId: "quest", title: "Source", entryLocationId: "workshop", initialBlocks: [workshop] })).kind, "created");
  const jobs = new MemoryAuthorAgentJobStore();
  const artifacts = new MemoryAuthorAgentProposalArtifactStore(jobs);
  const conversation = new MemoryAuthorConversationStore(jobs);
  const backend = new ScriptedAgentBackend({ backendId: "scripted-author", turnSteps: [{ kind: "success", outputText: output() }] });
  const control = createControlHttpServer({
    store,
    auth: { security, allowedOrigins: [ORIGIN], secureCookies: true },
    authorAssistant: { jobs, artifacts, conversation, backend, profileId: "author-profile", nowMs: clock(), backendDeadlineMs: 30000 }
  });
  const address = await control.listen();
  return { store, jobs, control, base: `http://${address.host}:${address.port}` };
}
async function login(base) {
  return request(base, "/control/v1/auth/login", { method: "POST", headers: { origin: ORIGIN }, json: { username: "editor.user", password: "editor password 123" } });
}
function sessionHeaders(loginResult) {
  const cookie = loginResult.headers.get("set-cookie");
  assert.ok(cookie);
  return { origin: ORIGIN, cookie: cookie.split(";", 1)[0], "x-csrf-token": loginResult.body.csrfToken };
}

test("B10.a job-scoped Apply resolves durable artifact, commits once and checkpoints once", async () => {
  const { store, jobs, control, base } = await setup();
  try {
    const auth = await login(base);
    const headers = sessionHeaders(auth);
    const created = await request(base, "/control/v1/projects/p1/quests/quest/author/jobs", { method: "POST", headers: { ...headers, "idempotency-key": "create-1" }, json: {} });
    assert.equal(created.status, 201);
    const jobId = created.body.job.jobId;
    const segment = await request(base, `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/segments`, { method: "POST", headers: { ...headers, "idempotency-key": "segment-1" }, json: { instruction: "Add paint" } });
    assert.equal(segment.status, 200);
    const proposalId = segment.body.proposal.proposalId;
    assert.equal((await store.getDraft("p1", "quest")).draftRevision, 0);

    const applyPath = `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/proposals/${proposalId}/apply`;
    const first = await request(base, applyPath, { method: "POST", headers: { ...headers, "idempotency-key": "apply-1" }, json: {} });
    assert.equal(first.status, 201);
    assert.equal(first.body.draft.draftRevision, 1);
    assert.equal((await store.getDraft("p1", "quest")).draftRevision, 1);
    let checkpoints = await jobs.listCheckpoints(jobId);
    assert.equal(checkpoints.filter((entry) => entry.fact.kind === "proposal.applied").length, 1);
    const appliedFact = checkpoints.find((entry) => entry.fact.kind === "proposal.applied").fact;
    assert.equal(appliedFact.proposalId, proposalId);
    assert.equal(appliedFact.resultRevision, 1);

    const replay = await request(base, applyPath, { method: "POST", headers: { ...headers, "idempotency-key": "apply-1" }, json: {} });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replay, true);
    checkpoints = await jobs.listCheckpoints(jobId);
    assert.equal(checkpoints.filter((entry) => entry.fact.kind === "proposal.applied").length, 1);
    assert.equal((await store.getDraft("p1", "quest")).draftRevision, 1);

    const fake = await request(base, `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/proposals/not-produced/apply`, { method: "POST", headers: { ...headers, "idempotency-key": "fake-1" }, json: {} });
    assert.equal(fake.status, 404);
  } finally { await control.close(); }
});

test("B10.a cancelled job cannot Apply a previously produced proposal", async () => {
  const { store, control, base } = await setup();
  try {
    const auth = await login(base);
    const headers = sessionHeaders(auth);
    const created = await request(base, "/control/v1/projects/p1/quests/quest/author/jobs", { method: "POST", headers: { ...headers, "idempotency-key": "create-cancel" }, json: {} });
    const jobId = created.body.job.jobId;
    const segment = await request(base, `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/segments`, { method: "POST", headers: { ...headers, "idempotency-key": "segment-cancel" }, json: { instruction: "Add paint" } });
    const proposalId = segment.body.proposal.proposalId;
    const cancelled = await request(base, `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/cancel`, { method: "POST", headers: { ...headers, "idempotency-key": "cancel-1" }, json: {} });
    assert.equal(cancelled.status, 200);
    const apply = await request(base, `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/proposals/${proposalId}/apply`, { method: "POST", headers: { ...headers, "idempotency-key": "apply-after-cancel" }, json: {} });
    assert.equal(apply.status, 409);
    assert.equal(apply.body.error.code, "AUTHOR_JOB_NOT_WAITING");
    assert.equal((await store.getDraft("p1", "quest")).draftRevision, 0);
  } finally { await control.close(); }
});

test("B10.a job-scoped Apply rejects browser-supplied proposal JSON before mutation", async () => {
  const { store, control, base } = await setup();
  try {
    const auth = await login(base);
    const headers = sessionHeaders(auth);
    const created = await request(base, "/control/v1/projects/p1/quests/quest/author/jobs", { method: "POST", headers: { ...headers, "idempotency-key": "create-body" }, json: {} });
    const jobId = created.body.job.jobId;
    const segment = await request(base, `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/segments`, { method: "POST", headers: { ...headers, "idempotency-key": "segment-body" }, json: { instruction: "Add paint" } });
    assert.equal(segment.status, 200);
    const proposalId = segment.body.proposal.proposalId;
    const attempted = await request(base, `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/proposals/${proposalId}/apply`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": "apply-body" },
      json: { proposal: { ...segment.body.proposal, explanation: "browser modified" } }
    });
    assert.equal(attempted.status, 400);
    assert.equal(attempted.body.error.code, "INVALID_AUTHOR_PROPOSAL_APPLY_REQUEST");
    assert.equal((await store.getDraft("p1", "quest")).draftRevision, 0);
  } finally { await control.close(); }
});
