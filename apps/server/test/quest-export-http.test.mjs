import test from "node:test";
import assert from "node:assert/strict";
import { MemoryControlSecurityStore, MemoryControlStore } from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../dist/control-server.js";

const ORIGIN = "https://studio.example";
const workshop = {
  schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Workshop", description: "", data: {}
};

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers: { ...(options.headers ?? {}) }
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function login(base, username, password) {
  const response = await fetch(`${base}/control/v1/auth/login`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

function sessionHeaders(loginResult) {
  const setCookie = loginResult.headers.get("set-cookie");
  assert.ok(setCookie);
  return { origin: ORIGIN, cookie: setCookie.split(";", 1)[0] };
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
    projectId: "p1", questId: "quest", title: "Original", entryLocationId: "workshop", initialBlocks: [workshop]
  })).kind, "created");
  assert.equal((await store.applyDraftChanges("p1", "quest", {
    baseRevision: 0, changes: [{ kind: "quest.title.set", title: "Current" }]
  })).kind, "updated");
  const control = createControlHttpServer({ store, auth: { security, allowedOrigins: [ORIGIN], secureCookies: true } });
  const address = await control.listen();
  return { store, control, base: `http://${address.host}:${address.port}` };
}

function readFirstLocalName(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  const nameLength = view.getUint16(26, true);
  return new TextDecoder().decode(bytes.subarray(30, 30 + nameLength));
}

test("B09-03 exact draft export is editor-only, query-exact and returns a real lhquest ZIP envelope", async () => {
  const { control, base } = await setup();
  try {
    const testerLogin = await login(base, "tester.user", "tester password 123");
    const tester = await request(base, "/control/v1/projects/p1/quests/quest/export?draftRevision=0", {
      headers: sessionHeaders(testerLogin)
    });
    assert.equal(tester.status, 403);
    assert.equal(tester.body.error.code, "CONTROL_FORBIDDEN");

    const editorLogin = await login(base, "editor.user", "editor password 123");
    const editorHeaders = sessionHeaders(editorLogin);
    const bad = await request(base, "/control/v1/projects/p1/quests/quest/export?draftRevision=0&current=1", {
      headers: editorHeaders
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "INVALID_QUEST_EXPORT_REQUEST");

    const exported = await request(base, "/control/v1/projects/p1/quests/quest/export?draftRevision=0", {
      headers: editorHeaders
    });
    assert.equal(exported.status, 200);
    assert.equal(exported.body.filename, "quest.r0.lhquest.zip");
    assert.equal(exported.body.mediaType, "application/vnd.living-history.quest+zip");
    assert.equal(exported.body.encoding, "base64");
    assert.equal(exported.body.manifest.source.kind, "draft");
    assert.equal(exported.body.manifest.source.draftRevision, 0);
    assert.equal(exported.body.manifest.source.questId, "quest");
    const bytes = Uint8Array.from(Buffer.from(exported.body.archiveBase64, "base64"));
    assert.ok(bytes.byteLength > 22);
    assert.equal(readFirstLocalName(bytes), "SHA256SUMS");

    const missing = await request(base, "/control/v1/projects/p1/quests/quest/export?draftRevision=99", {
      headers: editorHeaders
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "DRAFT_REVISION_NOT_FOUND");
    assert.equal(missing.body.error.revision, 99);
  } finally {
    await control.close();
  }
});
