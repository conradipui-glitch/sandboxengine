import test from "node:test";
import assert from "node:assert/strict";
import { MemoryControlSecurityStore, MemoryControlStore } from "../../../packages/control/dist/index.js";
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
  return request(base, "/control/v1/auth/login", { method: "POST", headers: { origin: ORIGIN }, json: { username, password } });
}

function sessionHeaders(loginResult, csrf = true) {
  const setCookie = loginResult.headers.get("set-cookie");
  assert.ok(setCookie);
  const headers = { origin: ORIGIN, cookie: setCookie.split(";", 1)[0] };
  if (csrf) headers["x-csrf-token"] = loginResult.body.csrfToken;
  return headers;
}

async function setup() {
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
    projectId: "p1", questId: "source", title: "Source", entryLocationId: "workshop", initialBlocks: [workshop, paint, action]
  })).kind, "created");
  const control = createControlHttpServer({ store, auth: { security, allowedOrigins: [ORIGIN], secureCookies: true } });
  const address = await control.listen();
  return { store, control, base: `http://${address.host}:${address.port}` };
}

test("B09-03 clone is editor-only, CSRF protected, idempotent and rewrites internal references", async () => {
  const { store, control, base } = await setup();
  try {
    const testerLogin = await login(base, "tester.user", "tester password 123");
    const tester = await request(base, "/control/v1/projects/p1/quests/source/clone", {
      method: "POST",
      headers: { ...sessionHeaders(testerLogin), "idempotency-key": "tester-clone" },
      json: { newQuestId: "tester-copy", title: "Tester copy" }
    });
    assert.equal(tester.status, 403);
    assert.equal(tester.body.error.code, "CONTROL_FORBIDDEN");
    assert.equal(await store.getDraft("p1", "tester-copy"), null);

    const editorLogin = await login(base, "editor.user", "editor password 123");
    const noCsrf = await request(base, "/control/v1/projects/p1/quests/source/clone", {
      method: "POST",
      headers: { ...sessionHeaders(editorLogin, false), "idempotency-key": "clone-no-csrf" },
      json: { newQuestId: "no-csrf-copy", title: "No CSRF" }
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.error.code, "CONTROL_CSRF_REQUIRED");
    assert.equal(await store.getDraft("p1", "no-csrf-copy"), null);

    const badQuery = await request(base, "/control/v1/projects/p1/quests/source/clone?force=1", {
      method: "POST",
      headers: { ...sessionHeaders(editorLogin), "idempotency-key": "clone-query" },
      json: { newQuestId: "query-copy", title: "Query copy" }
    });
    assert.equal(badQuery.status, 400);
    assert.equal(badQuery.body.error.code, "INVALID_QUEST_CLONE_REQUEST");
    assert.equal(await store.getDraft("p1", "query-copy"), null);

    const headers = { ...sessionHeaders(editorLogin), "idempotency-key": "clone-1" };
    const cloned = await request(base, "/control/v1/projects/p1/quests/source/clone", {
      method: "POST", headers, json: { newQuestId: "copy", title: "Copy" }
    });
    assert.equal(cloned.status, 201);
    assert.equal(cloned.body.sourceRevision, 0);
    assert.equal(cloned.body.draft.questId, "copy");
    const clonedPaint = cloned.body.draft.blocks.find((block) => block.kind === "core.resource");
    const clonedAction = cloned.body.draft.blocks.find((block) => block.kind === "core.action");
    assert.ok(clonedPaint && clonedAction);
    assert.notEqual(clonedPaint.id, "paint");
    assert.notEqual(clonedAction.id, "paint-wall");
    assert.equal(clonedAction.data.resourceId, clonedPaint.id);
    assert.equal((await store.getDraft("p1", "source")).draftRevision, 0);

    const replay = await request(base, "/control/v1/projects/p1/quests/source/clone", {
      method: "POST", headers, json: { newQuestId: "copy", title: "Copy" }
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replay, true);
    assert.deepEqual(replay.body.draft, cloned.body.draft);

    const reused = await request(base, "/control/v1/projects/p1/quests/source/clone", {
      method: "POST", headers, json: { newQuestId: "other-copy", title: "Copy" }
    });
    assert.equal(reused.status, 409);
    assert.equal(reused.body.error.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(await store.getDraft("p1", "other-copy"), null);
  } finally {
    await control.close();
  }
});
