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

async function setupCollaborationControl() {
  const directory = await mkdtemp(join(tmpdir(), "lh-fin12-collaboration-hardening-"));
  const store = new SQLiteControlStore({ path: join(directory, "control.sqlite") });
  const security = new MemoryControlSecurityStore(store);
  const control = createControlHttpServer({ store, auth: { security, allowedOrigins: [ORIGIN], secureCookies: true } });
  const address = await control.listen();
  const base = `http://${address.host}:${address.port}`;
  const accounts = [
    { userId: "owner", username: "owner.user", password: "owner password 123" },
    { userId: "editor", username: "editor.user", password: "editor password 123" },
    { userId: "editor2", username: "editor2.user", password: "editor2 password 123" },
    { userId: "tester", username: "tester.user", password: "tester password 123" },
    { userId: "outsider", username: "outsider.user", password: "outsider password 123" }
  ];
  for (const account of accounts) assert.equal((await security.provisionUser(account)).kind, "created");
  assert.equal((await security.createProjectAsOwner({ projectId: "project", title: "Проект" }, "owner")).kind, "created");
  for (const [userId, role] of [["editor", "editor"], ["editor2", "editor"], ["tester", "tester"]]) {
    assert.equal((await security.setProjectMemberRole("project", userId, role)).kind, "updated");
  }
  // A second project the editor/tester/outsider are NOT members of.
  assert.equal((await security.createProjectAsOwner({ projectId: "other", title: "Другой" }, "owner")).kind, "created");
  assert.equal((await store.createQuest({ projectId: "project", questId: "quest", title: "Квест", entryLocationId: "workshop", initialBlocks: [workshop] })).kind, "created");
  assert.equal((await store.createQuest({ projectId: "other", questId: "quest", title: "Квест", entryLocationId: "workshop", initialBlocks: [workshop] })).kind, "created");
  const logins = {};
  for (const account of accounts) {
    const loggedIn = await login(base, account.username, account.password);
    assert.equal(loggedIn.status, 200);
    logins[account.userId] = loggedIn;
  }
  return { directory, store, security, control, base, logins, collab: "/control/v1/projects/project/quests/quest/collaboration" };
}

async function disposeCollaborationControl(ctx) {
  await ctx.control.close();
  ctx.store.close();
  await rm(ctx.directory, { recursive: true, force: true });
}

test("FIN-12 collaboration HTTP: note/comment routes serve only an authorised caller", async () => {
  const ctx = await setupCollaborationControl();
  try {
    const notes = `${ctx.collab}/notes`;

    // No session at all: read and write are both refused before any store call.
    const anonRead = await request(ctx.base, ctx.collab, { headers: { origin: ORIGIN } });
    assert.equal(anonRead.status, 401);
    assert.equal(anonRead.body.error.code, "CONTROL_AUTH_REQUIRED");
    const anonWrite = await request(ctx.base, notes, {
      method: "POST", headers: { origin: ORIGIN, "idempotency-key": "anon-1" },
      json: { text: "нет", position: { x: 1, y: 1 } }
    });
    assert.equal(anonWrite.status, 401);
    assert.equal(anonWrite.body.error.code, "CONTROL_AUTH_REQUIRED");

    // A tester member may read the collection but may not write it.
    const testerRead = await request(ctx.base, ctx.collab, { headers: sessionHeaders(ctx.logins.tester) });
    assert.equal(testerRead.status, 200);
    assert.equal(testerRead.body.collaboration.revision, 0);
    const testerWrite = await request(ctx.base, notes, {
      method: "POST", headers: { ...sessionHeaders(ctx.logins.tester), "idempotency-key": "tester-1" },
      json: { text: "нельзя", position: { x: 1, y: 1 } }
    });
    assert.equal(testerWrite.status, 403);
    assert.equal(testerWrite.body.error.code, "CONTROL_FORBIDDEN");

    // A non-member sees nothing: 404 on read and write, never a role leak.
    assert.equal((await request(ctx.base, ctx.collab, { headers: sessionHeaders(ctx.logins.outsider) })).status, 404);
    assert.equal((await request(ctx.base, notes, {
      method: "POST", headers: { ...sessionHeaders(ctx.logins.outsider), "idempotency-key": "outsider-1" },
      json: { text: "нет", position: { x: 1, y: 1 } }
    })).status, 404);

    // CSRF and idempotency-key remain mandatory editor writes.
    const noCsrf = await request(ctx.base, notes, {
      method: "POST", headers: { ...sessionHeaders(ctx.logins.editor, false), "idempotency-key": "editor-nocsrf" },
      json: { text: "нет", position: { x: 1, y: 1 } }
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.error.code, "CONTROL_CSRF_REQUIRED");
    const noKey = await request(ctx.base, notes, {
      method: "POST", headers: sessionHeaders(ctx.logins.editor),
      json: { text: "нет", position: { x: 1, y: 1 } }
    });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.body.error.code, "INVALID_IDEMPOTENCY_KEY");

    // Only the documented methods and subroutes exist under /collaboration.
    assert.equal((await request(ctx.base, notes, { headers: sessionHeaders(ctx.logins.editor) })).status, 404);
    assert.equal((await request(ctx.base, ctx.collab, { method: "PATCH", headers: sessionHeaders(ctx.logins.editor) })).status, 404);
    assert.equal((await request(ctx.base, ctx.collab, { method: "DELETE", headers: sessionHeaders(ctx.logins.editor) })).status, 404);
    const bogus = await request(ctx.base, `${ctx.collab}/bogus`, {
      method: "POST", headers: { ...sessionHeaders(ctx.logins.editor), "idempotency-key": "editor-bogus" }, json: {}
    });
    assert.equal(bogus.status, 404);

    // A foreign project stays invisible even though the route shape matches.
    assert.equal((await request(ctx.base, "/control/v1/projects/other/quests/quest/collaboration", { headers: sessionHeaders(ctx.logins.editor) })).status, 404);

    // None of the refused calls touched the server state.
    assert.equal((await ctx.store.getCollaboration("project", "quest")).revision, 0);
  } finally {
    await disposeCollaborationControl(ctx);
  }
});

test("FIN-12 collaboration HTTP: notes keep CAS, authorship and tombstones over the wire", async () => {
  const ctx = await setupCollaborationControl();
  try {
    const notes = `${ctx.collab}/notes`;
    const editorKey = (key) => ({ ...sessionHeaders(ctx.logins.editor), "idempotency-key": key });

    const created = await request(ctx.base, notes, {
      method: "POST", headers: editorKey("e-note-1"), json: { text: "Проверить фон", position: { x: 12, y: 34 } }
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.collaboration.revision, 1);
    const note = created.body.collaboration.notes[0];
    assert.equal(note.authorUserId, "editor");
    assert.equal(note.revision, 1);

    // Idempotent replay returns the original revision; a reused key with another
    // body is a conflict, not a silent second note.
    const replay = await request(ctx.base, notes, {
      method: "POST", headers: editorKey("e-note-1"), json: { text: "Проверить фон", position: { x: 12, y: 34 } }
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replay, true);
    assert.equal(replay.body.collaboration.revision, 1);
    const reused = await request(ctx.base, notes, {
      method: "POST", headers: editorKey("e-note-1"), json: { text: "Другое", position: { x: 12, y: 34 } }
    });
    assert.equal(reused.status, 409);
    assert.equal(reused.body.error.code, "COLLABORATION_IDEMPOTENCY_KEY_REUSED");

    const noteChanges = `${notes}/${note.noteId}/changes`;
    // Another editor may not edit a note they did not write.
    const foreign = await request(ctx.base, noteChanges, {
      method: "POST", headers: { ...sessionHeaders(ctx.logins.editor2), "idempotency-key": "e2-note-foreign" },
      json: { expectedRevision: 1, text: "чужое", position: { x: 1, y: 1 } }
    });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.error.code, "COLLABORATION_FORBIDDEN");
    // The owner may.
    const ownerEdit = await request(ctx.base, noteChanges, {
      method: "POST", headers: { ...sessionHeaders(ctx.logins.owner), "idempotency-key": "o-note-1" },
      json: { expectedRevision: 1, text: "Правка владельца", position: { x: 13, y: 35 } }
    });
    assert.equal(ownerEdit.status, 200);
    assert.equal(ownerEdit.body.collaboration.notes[0].revision, 2);
    // A stale base revision is a 409 carrying the current revision, never a merge.
    const stale = await request(ctx.base, noteChanges, {
      method: "POST", headers: editorKey("e-note-stale"),
      json: { expectedRevision: 1, text: "устарело", position: { x: 13, y: 35 } }
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "COLLABORATION_REVISION_CONFLICT");
    assert.equal(stale.body.error.currentRevision, 2);
    assert.equal((await ctx.store.getCollaboration("project", "quest")).notes[0].text, "Правка владельца");

    // Unknown note ids and malformed bodies never create or mutate anything.
    assert.equal((await request(ctx.base, `${notes}/note-404/changes`, {
      method: "POST", headers: editorKey("e-note-404"),
      json: { expectedRevision: 1, text: "x", position: { x: 1, y: 1 } }
    })).status, 404);
    assert.equal((await request(ctx.base, `${notes}/note-404/delete`, {
      method: "POST", headers: editorKey("e-note-404-del"), json: { expectedRevision: 1 }
    })).status, 404);
    assert.equal((await request(ctx.base, noteChanges, {
      method: "POST", headers: editorKey("e-note-bad"), json: { expectedRevision: 1, text: "x" }
    })).status, 400);
    assert.equal((await request(ctx.base, noteChanges, {
      method: "POST", headers: editorKey("e-note-badkey"), json: { expectedRevision: 1, text: "x", position: { x: 1, y: 1 }, extra: true }
    })).status, 400);
    assert.equal((await request(ctx.base, notes, {
      method: "POST", headers: editorKey("e-note-badpos"), json: { text: "x", position: { x: 1, y: "нет" } }
    })).status, 422);
    assert.equal((await request(ctx.base, notes, {
      method: "POST", headers: editorKey("e-note-ctrl"), json: { text: "a\u0007b", position: { x: 1, y: 1 } }
    })).status, 422);

    // Delete is a tombstone: the note leaves the view and cannot be deleted twice.
    const deleted = await request(ctx.base, `${notes}/${note.noteId}/delete`, {
      method: "POST", headers: { ...sessionHeaders(ctx.logins.owner), "idempotency-key": "o-note-delete" },
      json: { expectedRevision: 2 }
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body.collaboration.notes, []);
    assert.equal(deleted.body.collaboration.revision, 3);
    assert.equal((await request(ctx.base, `${notes}/${note.noteId}/delete`, {
      method: "POST", headers: { ...sessionHeaders(ctx.logins.owner), "idempotency-key": "o-note-delete-again" },
      json: { expectedRevision: 3 }
    })).status, 404);
  } finally {
    await disposeCollaborationControl(ctx);
  }
});

test("FIN-12 collaboration HTTP: comment threads, replies, status transitions and unknown ids", async () => {
  const ctx = await setupCollaborationControl();
  try {
    const comments = `${ctx.collab}/comments`;
    const editorKey = (key) => ({ ...sessionHeaders(ctx.logins.editor), "idempotency-key": key });

    const first = await request(ctx.base, comments, {
      method: "POST", headers: editorKey("e-thread-1"),
      json: { anchor: { kind: "scene", targetId: "workshop", position: null }, text: "Обсудить сцену" }
    });
    assert.equal(first.status, 201);
    const t1 = first.body.collaboration.threads[0];
    assert.equal(t1.status, "open");
    assert.equal(t1.revision, 1);
    assert.equal(t1.messages.length, 1);
    assert.equal(t1.messages[0].authorUserId, "editor");
    assert.equal(first.body.collaboration.unresolvedThreadCount, 1);
    const second = await request(ctx.base, comments, {
      method: "POST", headers: editorKey("e-thread-2"),
      json: { anchor: { kind: "board", targetId: null, position: { x: 400, y: 500 } }, text: "Пин на доске" }
    });
    assert.equal(second.status, 201);
    const t2 = second.body.collaboration.threads.find((entry) => entry.anchor.kind === "board");

    // A reply attaches to the addressed thread only and records the author.
    const reply = await request(ctx.base, `${comments}/${t1.threadId}/messages`, {
      method: "POST", headers: { ...sessionHeaders(ctx.logins.owner), "idempotency-key": "o-reply-1" },
      json: { text: "Беру на себя" }
    });
    assert.equal(reply.status, 200);
    const t1After = reply.body.collaboration.threads.find((entry) => entry.threadId === t1.threadId);
    const t2After = reply.body.collaboration.threads.find((entry) => entry.threadId === t2.threadId);
    assert.equal(t1After.messages.length, 2);
    assert.equal(t1After.messages[1].authorUserId, "owner");
    assert.equal(t1After.messages[1].text, "Беру на себя");
    assert.equal(t1After.revision, 2);
    assert.equal(t2After.messages.length, 1);
    assert.equal(t2After.revision, 1);
    // Replying to a thread that does not exist is a 404, not a new thread.
    assert.equal((await request(ctx.base, `${comments}/thread-404/messages`, {
      method: "POST", headers: { ...sessionHeaders(ctx.logins.owner), "idempotency-key": "o-reply-404" },
      json: { text: "нет треда" }
    })).status, 404);

    const messageId = t1After.messages[0].messageId;
    // Unknown message id and a real id addressed under the wrong thread: 404 both.
    assert.equal((await request(ctx.base, `${comments}/${t1.threadId}/messages/message-404/changes`, {
      method: "POST", headers: editorKey("e-msg-404"), json: { expectedRevision: 1, text: "x" }
    })).status, 404);
    assert.equal((await request(ctx.base, `${comments}/${t2.threadId}/messages/${messageId}/changes`, {
      method: "POST", headers: editorKey("e-msg-wrong-thread"), json: { expectedRevision: 1, text: "x" }
    })).status, 404);
    assert.equal((await request(ctx.base, `${comments}/${t1.threadId}/messages/message-404/delete`, {
      method: "POST", headers: editorKey("e-msg-404-del"), json: { expectedRevision: 1 }
    })).status, 404);

    // Message edits are authorship- and CAS-guarded.
    const msgChanges = `${comments}/${t1.threadId}/messages/${messageId}/changes`;
    const foreignMessage = await request(ctx.base, msgChanges, {
      method: "POST", headers: { ...sessionHeaders(ctx.logins.editor2), "idempotency-key": "e2-msg-foreign" },
      json: { expectedRevision: 1, text: "чужая правка" }
    });
    assert.equal(foreignMessage.status, 403);
    assert.equal(foreignMessage.body.error.code, "COLLABORATION_FORBIDDEN");
    const staleMessage = await request(ctx.base, msgChanges, {
      method: "POST", headers: editorKey("e-msg-stale"), json: { expectedRevision: 9, text: "устарело" }
    });
    assert.equal(staleMessage.status, 409);
    assert.equal(staleMessage.body.error.code, "COLLABORATION_REVISION_CONFLICT");
    assert.equal(staleMessage.body.error.currentRevision, 1);
    const editedMessage = await request(ctx.base, msgChanges, {
      method: "POST", headers: editorKey("e-msg-edit"), json: { expectedRevision: 1, text: "Уточнённый текст" }
    });
    assert.equal(editedMessage.status, 200);
    const edited = editedMessage.body.collaboration.threads.find((entry) => entry.threadId === t1.threadId).messages[0];
    assert.equal(edited.text, "Уточнённый текст");
    assert.equal(edited.revision, 2);

    // Soft delete keeps the slot so the thread order stays honest.
    const removedMessage = await request(ctx.base, `${comments}/${t1.threadId}/messages/${messageId}/delete`, {
      method: "POST", headers: editorKey("e-msg-delete"), json: { expectedRevision: 2 }
    });
    assert.equal(removedMessage.status, 200);
    const afterRemove = removedMessage.body.collaboration.threads.find((entry) => entry.threadId === t1.threadId);
    assert.equal(afterRemove.messages.length, 2);
    assert.equal(afterRemove.messages[0].messageId, messageId);
    assert.equal(afterRemove.messages[0].deleted, true);
    assert.equal(afterRemove.messages[0].text, "");
    assert.equal((await request(ctx.base, `${comments}/${t1.threadId}/messages/${messageId}/delete`, {
      method: "POST", headers: editorKey("e-msg-delete-again"), json: { expectedRevision: 3 }
    })).status, 404);

    // Status transitions: open -> resolved -> open, all CAS-guarded.
    const statusPath = `${comments}/${t1.threadId}/status`;
    const currentRevision = afterRemove.revision;
    const invalidStatus = await request(ctx.base, statusPath, {
      method: "POST", headers: editorKey("e-status-invalid"), json: { expectedRevision: currentRevision, status: "closed" }
    });
    assert.equal(invalidStatus.status, 400);
    assert.equal(invalidStatus.body.error.code, "INVALID_COLLABORATION_REQUEST");
    assert.equal((await request(ctx.base, `${comments}/thread-404/status`, {
      method: "POST", headers: editorKey("e-status-404"), json: { expectedRevision: 1, status: "open" }
    })).status, 404);

    const resolved = await request(ctx.base, statusPath, {
      method: "POST", headers: editorKey("e-resolve-1"), json: { expectedRevision: currentRevision, status: "resolved" }
    });
    assert.equal(resolved.status, 200);
    const resolvedThread = resolved.body.collaboration.threads.find((entry) => entry.threadId === t1.threadId);
    assert.equal(resolvedThread.status, "resolved");
    assert.equal(Number.isFinite(resolvedThread.resolvedAtMs), true);
    assert.equal(resolved.body.collaboration.unresolvedThreadCount, 1);

    const staleStatus = await request(ctx.base, statusPath, {
      method: "POST", headers: editorKey("e-resolve-stale"), json: { expectedRevision: currentRevision, status: "open" }
    });
    assert.equal(staleStatus.status, 409);
    assert.equal(staleStatus.body.error.code, "COLLABORATION_REVISION_CONFLICT");
    assert.equal(staleStatus.body.error.currentRevision, currentRevision + 1);
    assert.equal((await ctx.store.getCollaboration("project", "quest")).threads.find((entry) => entry.threadId === t1.threadId).status, "resolved");

    const reopened = await request(ctx.base, statusPath, {
      method: "POST", headers: editorKey("e-reopen-1"), json: { expectedRevision: currentRevision + 1, status: "open" }
    });
    assert.equal(reopened.status, 200);
    const reopenedThread = reopened.body.collaboration.threads.find((entry) => entry.threadId === t1.threadId);
    assert.equal(reopenedThread.status, "open");
    assert.equal(reopenedThread.resolvedAtMs, null);
    assert.equal(reopened.body.collaboration.unresolvedThreadCount, 2);

    // Notes/comments never move the gameplay draft.
    const draft = await ctx.store.getDraft("project", "quest");
    assert.equal(draft.draftRevision, 0);
    assert.equal(draft.contentHash, (await ctx.store.getDraftSnapshot("project", "quest", 0)).contentHash);
  } finally {
    await disposeCollaborationControl(ctx);
  }
});
