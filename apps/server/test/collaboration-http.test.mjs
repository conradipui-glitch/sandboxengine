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
const workshop = { schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: {} };

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

test("FIN-12 collaboration HTTP: two accounts share notes/threads under live project roles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-fin12-collaboration-"));
  const store = new SQLiteControlStore({ path: join(directory, "control.sqlite") });
  const security = new MemoryControlSecurityStore(store);
  const control = createControlHttpServer({ store, auth: { security, allowedOrigins: [ORIGIN], secureCookies: true } });
  const address = await control.listen();
  const base = `http://${address.host}:${address.port}`;
  const notesPath = "/control/v1/projects/p1/quests/q1/collaboration/notes";
  const collabPath = "/control/v1/projects/p1/quests/q1/collaboration";
  try {
    for (const user of [
      { userId: "owner", username: "owner.user", password: "owner password 123" },
      { userId: "editor", username: "editor.user", password: "editor password 123" },
      { userId: "tester", username: "tester.user", password: "tester password 123" }
    ]) assert.equal((await security.provisionUser(user)).kind, "created");
    assert.equal((await security.createProjectAsOwner({ projectId: "p1", title: "Project" }, "owner")).kind, "created");
    assert.equal((await security.setProjectMemberRole("p1", "editor", "editor")).kind, "updated");
    assert.equal((await security.setProjectMemberRole("p1", "tester", "tester")).kind, "updated");
    // A second project the editor/tester are NOT members of.
    assert.equal((await security.createProjectAsOwner({ projectId: "p2", title: "Other" }, "owner")).kind, "created");
    assert.equal((await store.createQuest({ projectId: "p1", questId: "q1", title: "Quest", entryLocationId: "workshop", initialBlocks: [workshop] })).kind, "created");
    assert.equal((await store.createQuest({ projectId: "p2", questId: "q2", title: "Other", entryLocationId: "workshop", initialBlocks: [workshop] })).kind, "created");

    const editorLogin = await login(base, "editor.user", "editor password 123");
    const testerLogin = await login(base, "tester.user", "tester password 123");
    const ownerLogin = await login(base, "owner.user", "owner password 123");

    // tester may read but not write
    const testerRead = await request(base, collabPath, { headers: sessionHeaders(testerLogin) });
    assert.equal(testerRead.status, 200);
    assert.equal(testerRead.body.collaboration.revision, 0);
    const testerWrite = await request(base, notesPath, {
      method: "POST", headers: { ...sessionHeaders(testerLogin), "idempotency-key": "t-write" },
      json: { text: "нельзя", position: { x: 1, y: 1 } }
    });
    assert.equal(testerWrite.status, 403);
    assert.equal(testerWrite.body.error.code, "CONTROL_FORBIDDEN");

    // CSRF + idempotency-key are mandatory editor writes
    const noCsrf = await request(base, notesPath, {
      method: "POST", headers: { ...sessionHeaders(editorLogin, false), "idempotency-key": "e-nocsrf" },
      json: { text: "нет csrf", position: { x: 1, y: 1 } }
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.error.code, "CONTROL_CSRF_REQUIRED");
    const noKey = await request(base, notesPath, { method: "POST", headers: sessionHeaders(editorLogin), json: { text: "нет ключа", position: { x: 1, y: 1 } } });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.body.error.code, "INVALID_IDEMPOTENCY_KEY");

    const createdNote = await request(base, notesPath, {
      method: "POST", headers: { ...sessionHeaders(editorLogin), "idempotency-key": "e-note-1" },
      json: { text: "Проверить фон", position: { x: 12, y: 34 } }
    });
    assert.equal(createdNote.status, 201);
    const note = createdNote.body.collaboration.notes[0];
    assert.equal(note.authorUserId, "editor");
    const replayNote = await request(base, notesPath, {
      method: "POST", headers: { ...sessionHeaders(editorLogin), "idempotency-key": "e-note-1" },
      json: { text: "Проверить фон", position: { x: 12, y: 34 } }
    });
    assert.equal(replayNote.status, 200);
    assert.equal(replayNote.body.replay, true);

    const badPosition = await request(base, notesPath, {
      method: "POST", headers: { ...sessionHeaders(editorLogin), "idempotency-key": "e-bad-pos" },
      json: { text: "плохая позиция", position: { x: 1, y: "нет" } }
    });
    assert.equal(badPosition.status, 422);
    assert.equal(badPosition.body.error.code, "INVALID_COLLABORATION_REQUEST");

    // threads: create (editor) + reply (owner) + resolve (editor)
    const thread = await request(base, "/control/v1/projects/p1/quests/q1/collaboration/comments", {
      method: "POST", headers: { ...sessionHeaders(editorLogin), "idempotency-key": "e-thread-1" },
      json: { anchor: { kind: "board", targetId: null, position: { x: 400, y: 500 } }, text: "Обсудить сцену" }
    });
    assert.equal(thread.status, 201);
    const threadId = thread.body.collaboration.threads[0].threadId;
    assert.equal(thread.body.collaboration.unresolvedThreadCount, 1);

    const reply = await request(base, `/control/v1/projects/p1/quests/q1/collaboration/comments/${threadId}/messages`, {
      method: "POST", headers: { ...sessionHeaders(ownerLogin), "idempotency-key": "o-reply-1" },
      json: { text: "Беру на себя" }
    });
    assert.equal(reply.status, 200);
    const sharedThread = reply.body.collaboration.threads.find((entry) => entry.threadId === threadId);
    assert.equal(sharedThread.messages.length, 2);
    assert.equal(sharedThread.messages[0].authorUserId, "editor");
    assert.equal(sharedThread.messages[1].authorUserId, "owner");

    const resolved = await request(base, `/control/v1/projects/p1/quests/q1/collaboration/comments/${threadId}/status`, {
      method: "POST", headers: { ...sessionHeaders(editorLogin), "idempotency-key": "e-resolve-1" },
      json: { expectedRevision: sharedThread.revision, status: "resolved" }
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.collaboration.threads[0].status, "resolved");
    assert.equal(resolved.body.collaboration.unresolvedThreadCount, 0);

    // The other account sees the same server state.
    const ownerRead = await request(base, collabPath, { headers: sessionHeaders(ownerLogin) });
    assert.equal(ownerRead.status, 200);
    assert.equal(ownerRead.body.collaboration.notes.length, 1);
    assert.equal(ownerRead.body.collaboration.threads[0].status, "resolved");

    // Authorship rules: the editor did not write the owner's reply.
    const ownerMessageId = sharedThread.messages[1].messageId;
    const foreignEdit = await request(base, `/control/v1/projects/p1/quests/q1/collaboration/comments/${threadId}/messages/${ownerMessageId}/changes`, {
      method: "POST", headers: { ...sessionHeaders(editorLogin), "idempotency-key": "e-foreign-edit" },
      json: { expectedRevision: 1, text: "чужая правка" }
    });
    assert.equal(foreignEdit.status, 403);
    assert.equal(foreignEdit.body.error.code, "COLLABORATION_FORBIDDEN");

    // Foreign project is invisible to a non-member (404, not a role leak).
    const foreignProject = await request(base, "/control/v1/projects/p2/quests/q2/collaboration", { headers: sessionHeaders(editorLogin) });
    assert.equal(foreignProject.status, 404);

    // Revoked access stops reading immediately.
    assert.equal(await security.revokeSession(testerLogin.body.session.sessionId), true);
    const revokedRead = await request(base, collabPath, { headers: sessionHeaders(testerLogin) });
    assert.equal(revokedRead.status, 401);
    assert.equal(revokedRead.body.error.code, "CONTROL_AUTH_REQUIRED");

    // Notes/comments never moved the gameplay draft.
    const draft = await store.getDraft("p1", "q1");
    assert.equal(draft.draftRevision, 0);
    assert.equal(draft.contentHash, (await store.getDraftSnapshot("p1", "q1", 0)).contentHash);
    assert.equal((await store.getCollaboration("p1", "q1")).notes[0].revision, 1);
  } finally {
    await control.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
