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

test("B09-03 HTTP export/import round trip is editor-only, CSRF protected, idempotent and never auto-publishes", async () => {
  const { store, control, base } = await setup();
  try {
    const editorLogin = await login(base, "editor.user", "editor password 123");
    const editorRead = sessionHeaders(editorLogin, false);
    const exported = await request(base, "/control/v1/projects/p1/quests/source/export?draftRevision=0", { headers: editorRead });
    assert.equal(exported.status, 200);
    assert.equal(exported.body.encoding, "base64");

    const testerLogin = await login(base, "tester.user", "tester password 123");
    const tester = await request(base, "/control/v1/projects/p1/imports", {
      method: "POST",
      headers: { ...sessionHeaders(testerLogin), "idempotency-key": "tester-import" },
      json: { newQuestId: "tester-copy", archiveBase64: exported.body.archiveBase64 }
    });
    assert.equal(tester.status, 403);
    assert.equal(tester.body.error.code, "CONTROL_FORBIDDEN");
    assert.equal(await store.getDraft("p1", "tester-copy"), null);

    const noCsrf = await request(base, "/control/v1/projects/p1/imports", {
      method: "POST",
      headers: { ...editorRead, "idempotency-key": "no-csrf" },
      json: { newQuestId: "no-csrf-copy", archiveBase64: exported.body.archiveBase64 }
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.error.code, "CONTROL_CSRF_REQUIRED");
    assert.equal(await store.getDraft("p1", "no-csrf-copy"), null);

    const headers = { ...sessionHeaders(editorLogin), "idempotency-key": "import-1" };
    const imported = await request(base, "/control/v1/projects/p1/imports", {
      method: "POST", headers,
      json: { newQuestId: "copy", archiveBase64: exported.body.archiveBase64 }
    });
    assert.equal(imported.status, 201);
    assert.equal(imported.body.sourceQuestId, "source");
    assert.equal(imported.body.sourceRevision, 0);
    assert.equal(imported.body.draft.questId, "copy");
    assert.equal(imported.body.draft.draftRevision, 0);
    assert.equal(imported.body.draft.title, "Source");
    assert.deepEqual(imported.body.draft.blocks, (await store.getDraft("p1", "source")).blocks);

    const replay = await request(base, "/control/v1/projects/p1/imports", {
      method: "POST", headers,
      json: { newQuestId: "copy", archiveBase64: exported.body.archiveBase64 }
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replay, true);
    assert.deepEqual(replay.body.draft, imported.body.draft);

    const reused = await request(base, "/control/v1/projects/p1/imports", {
      method: "POST", headers,
      json: { newQuestId: "other-copy", archiveBase64: exported.body.archiveBase64 }
    });
    assert.equal(reused.status, 409);
    assert.equal(reused.body.error.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(await store.getDraft("p1", "other-copy"), null);

    const malformed = await request(base, "/control/v1/projects/p1/imports", {
      method: "POST",
      headers: { ...sessionHeaders(editorLogin), "idempotency-key": "malformed" },
      json: { newQuestId: "malformed-copy", archiveBase64: "%%%%" }
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, "INVALID_QUEST_IMPORT_REQUEST");
    assert.equal(await store.getDraft("p1", "malformed-copy"), null);

    const corruptedBytes = Buffer.from(exported.body.archiveBase64, "base64");
    corruptedBytes[0] ^= 0xff;
    const corrupted = await request(base, "/control/v1/projects/p1/imports", {
      method: "POST",
      headers: { ...sessionHeaders(editorLogin), "idempotency-key": "corrupted" },
      json: { newQuestId: "corrupted-copy", archiveBase64: corruptedBytes.toString("base64") }
    });
    assert.equal(corrupted.status, 422);
    assert.equal(corrupted.body.error.code, "INVALID_LHQUEST_PACKAGE");
    assert.equal(await store.getDraft("p1", "corrupted-copy"), null);

    assert.equal((await store.listQuests("p1")).length, 2);
  } finally {
    await control.close();
  }
});
