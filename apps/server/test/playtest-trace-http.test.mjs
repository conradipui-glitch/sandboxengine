import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryControlSecurityStore,
  MemoryControlStore
} from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../dist/control-server.js";

const workshop = Object.freeze({
  schemaVersion: "1.0",
  id: "workshop",
  kind: "core.location",
  title: "Workshop",
  description: "",
  data: Object.freeze({})
});

async function request(base, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  let body;
  if (Object.hasOwn(options, "json")) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers,
    body
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function login(base, username, password) {
  const response = await request(base, "/control/v1/auth/login", {
    method: "POST",
    json: { username, password }
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  return {
    cookie: setCookie.split(";", 1)[0],
    csrf: response.body.csrfToken
  };
}

function headers(session, csrf = false) {
  return csrf
    ? { cookie: session.cookie, "x-csrf-token": session.csrf }
    : { cookie: session.cookie };
}

test("B09-03 Control playtest trace is tester-readable, project-hidden and derives exact runtime identity server-side", async () => {
  const store = new MemoryControlStore();
  const security = new MemoryControlSecurityStore(store);
  for (const user of [
    { userId: "owner", username: "owner.user", password: "owner password 123" },
    { userId: "tester", username: "tester.user", password: "tester password 123" },
    { userId: "outsider", username: "outsider.user", password: "outsider password 123" }
  ]) {
    assert.equal((await security.provisionUser(user)).kind, "created");
  }
  assert.equal((await security.createProjectAsOwner({ projectId: "project", title: "Project" }, "owner")).kind, "created");
  assert.equal((await security.setProjectMemberRole("project", "tester", "tester")).kind, "updated");
  assert.equal((await store.createQuest({
    projectId: "project",
    questId: "quest",
    title: "Quest",
    entryLocationId: "workshop",
    initialBlocks: [workshop]
  })).kind, "created");
  const validated = await store.validateDraft("project", "quest", 0);
  assert.equal(validated.kind, "validated");
  assert.equal(validated.validation.status, "valid");
  const created = await store.createPlaytest({
    projectId: "project",
    questId: "quest",
    draftRevision: 0,
    validationId: validated.validation.validationId
  });
  assert.equal(created.kind, "created");
  const playtest = created.playtest;

  const calls = [];
  const traceReader = Object.freeze({
    async readPlaytestTrace(input) {
      calls.push(input);
      return {
        runtimePinnedRelease: {
          questId: input.questId,
          releaseId: input.releaseId,
          contentHash: input.contentHash
        },
        sessions: [{
          sessionId: "session-1",
          currentRevision: 1,
          operations: [{
            operationId: "op-1",
            expectedRevision: 0,
            status: "completed",
            completionKind: "turn",
            turn: {
              turnId: "turn-1",
              beforeRevision: 0,
              afterRevision: 1,
              stateHash: "f".repeat(64)
            },
            publicResponse: { action: { status: "executed" } }
          }],
          hasMoreOperations: false
        }],
        hasMoreSessions: false
      };
    }
  });

  const control = createControlHttpServer({
    store,
    playtestTrace: traceReader,
    auth: { security, allowedOrigins: [], secureCookies: false }
  });
  try {
    const address = await control.listen();
    const base = `http://${address.host}:${address.port}`;
    const tester = await login(base, "tester.user", "tester password 123");
    const outsider = await login(base, "outsider.user", "outsider password 123");

    const trace = await request(
      base,
      `/control/v1/projects/project/quests/quest/playtests/${playtest.playtestId}/trace`,
      { headers: headers(tester) }
    );
    assert.equal(trace.status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      questId: "quest",
      releaseId: `playtest-${playtest.playtestId}`,
      contentHash: playtest.contentHash
    });
    assert.equal(trace.body.trace.identityKind, "frozen_playtest");
    assert.equal(trace.body.trace.publishedRelease, false);
    assert.deepEqual(trace.body.trace.playtest, {
      playtestId: playtest.playtestId,
      projectId: "project",
      questId: "quest",
      draftRevision: 0,
      contentHash: playtest.contentHash,
      validationId: playtest.validationId,
      compiledContentHash: playtest.compiledContentHash
    });
    assert.equal(trace.body.trace.runtimePinnedRelease.releaseId, `playtest-${playtest.playtestId}`);
    assert.equal(trace.body.trace.sessions[0].operations[0].publicResponse.action.status, "executed");
    const serialized = JSON.stringify(trace.body);
    assert.equal(serialized.includes("credential"), false);
    assert.equal(serialized.includes("idempotencyKey"), false);
    assert.equal(serialized.includes("requestHash"), false);

    const hidden = await request(
      base,
      `/control/v1/projects/project/quests/quest/playtests/${playtest.playtestId}/trace`,
      { headers: headers(outsider) }
    );
    assert.equal(hidden.status, 404);
    assert.equal(calls.length, 1, "reader is not invoked for inaccessible project");

    const wrongQuest = await request(
      base,
      `/control/v1/projects/project/quests/other/playtests/${playtest.playtestId}/trace`,
      { headers: headers(tester) }
    );
    assert.equal(wrongQuest.status, 404);
    assert.equal(calls.length, 1, "reader is not invoked for mismatched playtest ownership");
  } finally {
    await control.close();
  }
});

test("B09-03 Control does not advertise fabricated trace when no reader is composed", async () => {
  const store = new MemoryControlStore();
  assert.equal((await store.createProject({ projectId: "project", title: "Project" })).kind, "created");
  assert.equal((await store.createQuest({
    projectId: "project",
    questId: "quest",
    title: "Quest",
    entryLocationId: "workshop",
    initialBlocks: [workshop]
  })).kind, "created");
  const validation = await store.validateDraft("project", "quest", 0);
  assert.equal(validation.kind, "validated");
  const created = await store.createPlaytest({
    projectId: "project",
    questId: "quest",
    draftRevision: 0,
    validationId: validation.validation.validationId
  });
  assert.equal(created.kind, "created");

  const control = createControlHttpServer({ store });
  try {
    const address = await control.listen();
    const base = `http://${address.host}:${address.port}`;
    const response = await request(
      base,
      `/control/v1/projects/project/quests/quest/playtests/${created.playtest.playtestId}/trace`
    );
    assert.equal(response.status, 404);
  } finally {
    await control.close();
  }
});
