import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryAuthorAgentJobStore,
  MemoryAuthorAgentProposalArtifactStore,
  MemoryControlSecurityStore,
  MemoryControlStore
} from "../../../packages/control/dist/index.js";
import { ScriptedAgentBackend } from "../../../packages/ai/dist/index.js";
import { createControlHttpServer } from "../dist/control-server.js";

const ORIGIN = "https://studio.example";
const workshop = {
  schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Workshop", description: "", data: {}
};
const paint = {
  schemaVersion: "1.0", id: "paint", kind: "core.resource", title: "Paint", description: "",
  data: { unit: "portion", initialValue: 4, min: 0, max: 20 }
};
const action = {
  schemaVersion: "1.0", id: "paint-wall", kind: "core.action", title: "Paint wall", description: "",
  data: { actionType: "core.paint", resourceId: "paint", resourceUnitsPerUnit: 1, durationSecondsPerUnit: 300, allowPartial: true }
};

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

async function request(base, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  let body;
  if (Object.hasOwn(options, "json")) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const response = await fetch(`${base}${path}`, { method: options.method ?? "GET", headers, body });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function login(base, username, password) {
  return request(base, "/control/v1/auth/login", {
    method: "POST", headers: { origin: ORIGIN }, json: { username, password }
  });
}

function sessionHeaders(loginResult, csrf = true) {
  const setCookie = loginResult.headers.get("set-cookie");
  assert.ok(setCookie);
  const headers = { origin: ORIGIN, cookie: setCookie.split(";", 1)[0] };
  if (csrf) headers["x-csrf-token"] = loginResult.body.csrfToken;
  return headers;
}

function clock(start = 1_000) {
  let value = start;
  return () => value++;
}

async function setup({ composeAuthorAssistant = true } = {}) {
  const store = new MemoryControlStore();
  const security = new MemoryControlSecurityStore(store);
  for (const user of [
    { userId: "owner", username: "owner.user", password: "owner password 123" },
    { userId: "editor", username: "editor.user", password: "editor password 123" },
    { userId: "tester", username: "tester.user", password: "tester password 123" }
  ]) assert.equal((await security.provisionUser(user)).kind, "created");
  assert.equal((await security.createProjectAsOwner({ projectId: "p1", title: "Project" }, "owner")).kind, "created");
  assert.equal((await security.setProjectMemberRole("p1", "editor", "editor")).kind, "updated");
  assert.equal((await security.setProjectMemberRole("p1", "tester", "tester")).kind, "updated");
  assert.equal((await store.createQuest({
    projectId: "p1", questId: "quest", title: "Source", entryLocationId: "workshop", initialBlocks: [workshop]
  })).kind, "created");

  const jobs = new MemoryAuthorAgentJobStore();
  const artifacts = new MemoryAuthorAgentProposalArtifactStore(jobs);
  const backend = new ScriptedAgentBackend({
    backendId: "scripted-author",
    turnSteps: [
      { kind: "success", outputText: validOutput(), usage: { inputTokens: 20, outputTokens: 12, totalTokens: 32 } },
      { kind: "success", outputText: validOutput(), usage: { inputTokens: 20, outputTokens: 12, totalTokens: 32 } }
    ],
    nowMs: () => 0
  });
  const nowMs = clock();
  const control = createControlHttpServer({
    store,
    auth: { security, allowedOrigins: [ORIGIN], secureCookies: true },
    ...(composeAuthorAssistant ? {
      authorAssistant: { jobs, artifacts, backend, profileId: "author-profile", nowMs, backendDeadlineMs: 30_000 }
    } : {})
  });
  const address = await control.listen();
  return { store, jobs, artifacts, backend, control, base: `http://${address.host}:${address.port}` };
}

async function createEditorJob(base, editorLogin, key = "job-create") {
  return request(base, "/control/v1/projects/p1/quests/quest/author/jobs", {
    method: "POST",
    headers: { ...sessionHeaders(editorLogin), "idempotency-key": key },
    json: {}
  });
}

test("B10.a author job HTTP is editor-only, CSRF protected and create is idempotent", async () => {
  const { jobs, control, base } = await setup();
  try {
    const testerLogin = await login(base, "tester.user", "tester password 123");
    const tester = await request(base, "/control/v1/projects/p1/quests/quest/author/jobs", {
      method: "POST",
      headers: { ...sessionHeaders(testerLogin), "idempotency-key": "tester-create" },
      json: {}
    });
    assert.equal(tester.status, 403);
    assert.equal(tester.body.error.code, "CONTROL_FORBIDDEN");

    const editorLogin = await login(base, "editor.user", "editor password 123");
    const noCsrf = await request(base, "/control/v1/projects/p1/quests/quest/author/jobs", {
      method: "POST",
      headers: { ...sessionHeaders(editorLogin, false), "idempotency-key": "no-csrf" },
      json: {}
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.error.code, "CONTROL_CSRF_REQUIRED");

    const created = await createEditorJob(base, editorLogin);
    assert.equal(created.status, 201);
    assert.equal(created.body.job.projectId, "p1");
    assert.equal(created.body.job.questId, "quest");
    assert.equal(created.body.job.ownerUserId, "editor");
    assert.equal(created.body.job.state, "queued");
    const jobId = created.body.job.jobId;
    assert.ok(await jobs.getJob(jobId));

    const replay = await createEditorJob(base, editorLogin);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replay, true);
    assert.equal(replay.body.job.jobId, jobId);

    const reused = await request(base, "/control/v1/projects/p1/quests/quest/author/jobs", {
      method: "POST",
      headers: { ...sessionHeaders(editorLogin), "idempotency-key": "job-create" },
      json: { maxToolCalls: 4 }
    });
    assert.equal(reused.status, 409);
    assert.equal(reused.body.error.code, "IDEMPOTENCY_KEY_REUSED");
  } finally {
    await control.close();
  }
});

test("B10.a author segment replays durable proposal and rejects changed instruction before backend", async () => {
  const { store, jobs, backend, control, base } = await setup();
  try {
    const editorLogin = await login(base, "editor.user", "editor password 123");
    const created = await createEditorJob(base, editorLogin, "segment-job");
    assert.equal(created.status, 201);
    const jobId = created.body.job.jobId;
    const path = `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/segments`;

    const noCsrf = await request(base, path, {
      method: "POST",
      headers: { ...sessionHeaders(editorLogin, false), "idempotency-key": "segment-1" },
      json: { instruction: "Add paint" }
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.error.code, "CONTROL_CSRF_REQUIRED");
    assert.equal(backend.capturedTurnRequests.length, 0);

    const headers = { ...sessionHeaders(editorLogin), "idempotency-key": "segment-1" };
    const first = await request(base, path, {
      method: "POST", headers, json: { instruction: "Add paint" }
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.job.state, "waiting_user");
    assert.equal(first.body.preview.stale, false);
    assert.equal(first.body.preview.applyAllowed, true);
    assert.equal(first.body.usage.totalTokens, 32);
    assert.equal((await store.getDraft("p1", "quest")).draftRevision, 0);
    assert.equal(backend.capturedTurnRequests.length, 1);

    const replay = await request(base, path, {
      method: "POST", headers, json: { instruction: "Add paint" }
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body.proposal, first.body.proposal);
    assert.equal(replay.body.usage.totalTokens, 32);
    assert.equal(backend.capturedTurnRequests.length, 1);
    assert.equal((await store.getDraft("p1", "quest")).draftRevision, 0);

    const changed = await request(base, path, {
      method: "POST", headers, json: { instruction: "Change something else" }
    });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(backend.capturedTurnRequests.length, 1);

    const read = await request(base, `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}`, {
      headers: sessionHeaders(editorLogin)
    });
    assert.equal(read.status, 200);
    const kinds = read.body.checkpoints.map((entry) => entry.fact.kind);
    assert.ok(kinds.includes("segment.requested"));
    assert.ok(kinds.includes("draft.read"));
    assert.ok(kinds.includes("proposal.produced"));
    assert.ok(kinds.includes("proposal.previewed"));
    assert.equal(kinds.filter((kind) => kind === "segment.requested").length, 1);
    assert.equal(kinds.filter((kind) => kind === "proposal.produced").length, 1);
    assert.ok(await jobs.getJob(jobId));
  } finally {
    await control.close();
  }
});

test("B10.a cancel is state-idempotent and blocks later author segments", async () => {
  const { backend, control, base } = await setup();
  try {
    const editorLogin = await login(base, "editor.user", "editor password 123");
    const created = await createEditorJob(base, editorLogin, "cancel-job");
    assert.equal(created.status, 201);
    const jobId = created.body.job.jobId;
    const cancelPath = `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/cancel`;
    const cancelHeaders = { ...sessionHeaders(editorLogin), "idempotency-key": "cancel-1" };

    const cancelled = await request(base, cancelPath, { method: "POST", headers: cancelHeaders, json: {} });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.job.state, "cancelled");

    const replay = await request(base, cancelPath, { method: "POST", headers: cancelHeaders, json: {} });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replay, true);
    assert.equal(replay.body.job.state, "cancelled");

    const segment = await request(base, `/control/v1/projects/p1/quests/quest/author/jobs/${jobId}/segments`, {
      method: "POST",
      headers: { ...sessionHeaders(editorLogin), "idempotency-key": "after-cancel" },
      json: { instruction: "Add paint" }
    });
    assert.equal(segment.status, 409);
    assert.equal(segment.body.error.code, "AUTHOR_JOB_NOT_RUNNABLE");
    assert.equal(backend.capturedTurnRequests.length, 0);
  } finally {
    await control.close();
  }
});

test("B10.a author job HTTP stays unavailable when author assistant is not composed", async () => {
  const { control, base } = await setup({ composeAuthorAssistant: false });
  try {
    const editorLogin = await login(base, "editor.user", "editor password 123");
    const result = await request(base, "/control/v1/projects/p1/quests/quest/author/jobs", {
      method: "POST",
      headers: { ...sessionHeaders(editorLogin), "idempotency-key": "missing-composition" },
      json: {}
    });
    assert.equal(result.status, 404);
  } finally {
    await control.close();
  }
});
