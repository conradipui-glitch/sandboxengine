import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryAuthorAgentJobStore,
  MemoryAuthorAgentProposalArtifactStore,
  MemoryAuthorConversationStore,
  MemoryControlSecurityStore,
  MemoryControlStore
} from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../dist/control-server.js";

const ORIGIN = "https://studio.example";
const HASHLESS_USAGE = Object.freeze({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
const workshop = { schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Workshop", description: "", data: {} };
const paint = { schemaVersion: "1.0", id: "paint", kind: "core.resource", title: "Paint", description: "", data: { unit: "portion", initialValue: 4, min: 0, max: 20 } };

function output() {
  return JSON.stringify({ explanation: "late output", changes: [{ kind: "block.add", block: paint }], missingCapabilities: [] });
}
function safeView() {
  return Object.freeze({
    backendId: "blocking-author",
    kind: "session_agent",
    capabilities: Object.freeze({ sessions: true, toolPolicy: "none", shell: false, filesystem: false, codeExecution: false, repositoryMutation: false, externalToolCalls: false })
  });
}
function blockingBackend() {
  let startTurn;
  const turnStarted = new Promise((resolve) => { startTurn = resolve; });
  let releaseTurn;
  const turnRelease = new Promise((resolve) => { releaseTurn = resolve; });
  let turnSignal = null;
  return {
    safeView: safeView(),
    turnStarted,
    releaseSuccess() { releaseTurn(); },
    get turnSignal() { return turnSignal; },
    async openSession() {
      return { ok: true, session: Object.freeze({ backendId: "blocking-author", sessionRef: "blocking-session" }), backendRequestId: null };
    },
    async runTurn(request) {
      turnSignal = request.signal ?? null;
      startTurn();
      await turnRelease;
      return { ok: true, outputText: output(), usage: HASHLESS_USAGE, backendRequestId: null };
    },
    async closeSession() { return { ok: true }; }
  };
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
  assert.equal((await security.provisionUser({ userId: "owner", username: "owner.user", password: "owner password 123" })).kind, "created");
  assert.equal((await security.provisionUser({ userId: "editor", username: "editor.user", password: "editor password 123" })).kind, "created");
  assert.equal((await security.createProjectAsOwner({ projectId: "p1", title: "Project" }, "owner")).kind, "created");
  assert.equal((await security.setProjectMemberRole("p1", "editor", "editor")).kind, "updated");
  assert.equal((await store.createQuest({ projectId: "p1", questId: "quest", title: "Source", entryLocationId: "workshop", initialBlocks: [workshop] })).kind, "created");
  const jobs = new MemoryAuthorAgentJobStore();
  const artifacts = new MemoryAuthorAgentProposalArtifactStore(jobs);
  const conversation = new MemoryAuthorConversationStore(jobs);
  const backend = blockingBackend();
  const control = createControlHttpServer({
    store,
    auth: { security, allowedOrigins: [ORIGIN], secureCookies: true },
    authorAssistant: { jobs, artifacts, conversation, backend, profileId: "author-profile", nowMs: clock(), backendDeadlineMs: 30000 }
  });
  const address = await control.listen();
  return { store, jobs, conversation, backend, control, base: `http://${address.host}:${address.port}` };
}
async function login(base) {
  return request(base, "/control/v1/auth/login", { method: "POST", headers: { origin: ORIGIN }, json: { username: "editor.user", password: "editor password 123" } });
}
function sessionHeaders(loginResult) {
  const cookie = loginResult.headers.get("set-cookie");
  assert.ok(cookie);
  return { origin: ORIGIN, cookie: cookie.split(";", 1)[0], "x-csrf-token": loginResult.body.csrfToken };
}

test("B10.a Stop aborts in-flight backend signal and discards a late success result", async () => {
  const { store, jobs, conversation, backend, control, base } = await setup();
  try {
    const auth = await login(base);
    const headers = sessionHeaders(auth);
    const created = await request(base, "/control/v1/projects/p1/quests/quest/author/jobs", { method: "POST", headers: { ...headers, "idempotency-key": "create-1" }, json: {} });
    assert.equal(created.status, 201);
    const jobId = created.body.job.jobId;
    const segmentPromise = request(base, `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/segments`, {
      method: "POST", headers: { ...headers, "idempotency-key": "segment-1" }, json: { instruction: "Add paint" }
    });
    await backend.turnStarted;
    assert.ok(backend.turnSignal);
    assert.equal(backend.turnSignal.aborted, false);

    const cancelled = await request(base, `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/cancel`, {
      method: "POST", headers: { ...headers, "idempotency-key": "cancel-1" }, json: {}
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.job.state, "cancelled");
    assert.equal(backend.turnSignal.aborted, true);

    backend.releaseSuccess();
    const segment = await segmentPromise;
    assert.equal(segment.status, 409);
    assert.equal(segment.body.error.code, "AUTHOR_CANCELLED");
    assert.equal((await store.getDraft("p1", "quest")).draftRevision, 0);
    const messages = await conversation.listMessages(jobId);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, "author");
    assert.equal(messages.some((message) => message.role === "assistant"), false);
    const checkpoints = await jobs.listCheckpoints(jobId);
    assert.equal(checkpoints.some((entry) => entry.fact.kind === "proposal.produced"), false);
    assert.equal(checkpoints.some((entry) => entry.fact.kind === "job.cancelled"), true);
  } finally { await control.close(); }
});
