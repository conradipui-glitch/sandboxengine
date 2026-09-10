import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SQLiteControlStore,
  MemoryControlSecurityStore
} from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../dist/control-server.js";

const ORIGIN = "https://studio.example";
const workshop = { schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Workshop", description: "", data: {} };

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

function sessionHeaders(loginResult, csrf = true, extra = {}) {
  const setCookie = loginResult.headers.get("set-cookie");
  assert.ok(setCookie);
  const headers = { origin: ORIGIN, cookie: setCookie.split(";", 1)[0], ...extra };
  if (csrf) headers["x-csrf-token"] = loginResult.body.csrfToken;
  return headers;
}

test("K06 hosted identity and BoardDocument roles are enforced server-side", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-k06-board-"));
  const dbPath = join(directory, "control.sqlite");
  const store = new SQLiteControlStore({ path: dbPath });
  const security = new MemoryControlSecurityStore(store);
  const control = createControlHttpServer({ store, boardStore: store, auth: { security, allowedOrigins: [ORIGIN], secureCookies: true } });
  const address = await control.listen();
  const base = `http://${address.host}:${address.port}`;
  try {
    for (const user of [
      { userId: "owner", username: "owner.user", password: "owner password 123" },
      { userId: "editor", username: "editor.user", password: "editor password 123" },
      { userId: "tester", username: "tester.user", password: "tester password 123" }
    ]) assert.equal((await security.provisionUser(user)).kind, "created");
    assert.equal((await security.createProjectAsOwner({ projectId: "p1", title: "Project" }, "owner")).kind, "created");
    assert.equal((await security.setProjectMemberRole("p1", "editor", "editor")).kind, "updated");
    assert.equal((await security.setProjectMemberRole("p1", "tester", "tester")).kind, "updated");
    assert.equal((await store.createQuest({ projectId: "p1", questId: "q1", title: "Quest", entryLocationId: "workshop", initialBlocks: [workshop] })).kind, "created");

    const testerLogin = await login(base, "tester.user", "tester password 123");
    const testerGet = await request(base, "/control/v1/projects/p1/quests/q1/board", { headers: sessionHeaders(testerLogin) });
    assert.equal(testerGet.status, 200);
    const testerWrite = await request(base, "/control/v1/projects/p1/quests/q1/board/changes", {
      method: "POST",
      headers: { ...sessionHeaders(testerLogin), "idempotency-key": "k06-tester-write" },
      json: { baseRevision: 0, positions: { workshop: { x: 99, y: 88 } } }
    });
    assert.equal(testerWrite.status, 403);
    assert.equal(testerWrite.body.error.code, "CONTROL_FORBIDDEN");

    const editorLogin = await login(base, "editor.user", "editor password 123");
    const editorWrite = await request(base, "/control/v1/projects/p1/quests/q1/board/changes", {
      method: "POST",
      headers: { ...sessionHeaders(editorLogin), "idempotency-key": "k06-editor-write" },
      json: { baseRevision: 0, positions: { workshop: { x: 12, y: 34 } } }
    });
    assert.equal(editorWrite.status, 200);
    assert.equal(editorWrite.body.board.boardRevision, 1);

    const forgedTesterWrite = await request(base, "/control/v1/projects/p1/quests/q1/board/changes", {
      method: "POST",
      headers: sessionHeaders(testerLogin, true, { "x-lh-user-id": "owner", "x-user-role": "owner", "idempotency-key": "k06-forged-owner" }),
      json: { baseRevision: 1, positions: { workshop: { x: 777, y: 777 } } }
    });
    assert.equal(forgedTesterWrite.status, 403);
    assert.deepEqual((await store.getBoardDocument("p1", "q1")).positions, { workshop: { x: 12, y: 34 } });

    assert.equal((await security.setProjectMemberRole("p1", "editor", "tester")).kind, "updated");
    const roleRevokedWrite = await request(base, "/control/v1/projects/p1/quests/q1/board/changes", {
      method: "POST",
      headers: { ...sessionHeaders(editorLogin), "idempotency-key": "k06-role-revoked" },
      json: { baseRevision: 1, positions: { workshop: { x: 55, y: 66 } } }
    });
    assert.equal(roleRevokedWrite.status, 403);

    assert.equal(await security.revokeSession(testerLogin.body.session.sessionId), true);
    const revokedGet = await request(base, "/control/v1/projects/p1/quests/q1/board", { headers: sessionHeaders(testerLogin) });
    assert.equal(revokedGet.status, 401);
    assert.equal(revokedGet.body.error.code, "CONTROL_AUTH_REQUIRED");
  } finally {
    await control.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
