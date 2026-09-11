import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteControlStore } from "../dist/index.js";

const workshop = Object.freeze({ schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: Object.freeze({}) });
const forward = Object.freeze({ schemaVersion: "1.0", id: "forward", kind: "core.location", title: "Вперёд", description: "", data: Object.freeze({}) });

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), "living-history-collaboration-"));
  const path = join(dir, "control.sqlite");
  const store = new SQLiteControlStore({ path });
  await store.createProject({ projectId: "p1", title: "Проект" });
  await store.createQuest({
    projectId: "p1",
    questId: "q1",
    title: "Квест",
    entryLocationId: "workshop",
    initialBlocks: [workshop, forward]
  });
  return { dir, path, store };
}

async function dispose(dir, store) {
  store.close();
  await rm(dir, { recursive: true, force: true });
}

test("FIN-12 collaboration store: notes and comment threads are server-authoritative, CAS and idempotent", async () => {
  const { dir, store } = await makeStore();
  try {
    const empty = await store.getCollaboration("p1", "q1");
    assert.equal(empty.revision, 0);
    assert.deepEqual(empty.notes, []);
    assert.deepEqual(empty.threads, []);
    assert.equal(empty.unresolvedThreadCount, 0);
    assert.equal(await store.getCollaboration("missing", "q1"), null);

    // --- note create / replay / key reuse ---
    const noteInput = { text: "Проверить фон сцены", position: { x: 10.5, y: 20 }, idempotencyKey: "note-1", actorUserId: "author-1" };
    const created = await store.createNote("p1", "q1", noteInput);
    assert.equal(created.kind, "created");
    assert.equal(created.view.revision, 1);
    assert.equal(created.view.notes.length, 1);
    const note = created.view.notes[0];
    assert.equal(note.text, "Проверить фон сцены");
    assert.equal(note.authorUserId, "author-1");
    assert.deepEqual(note.position, { x: 10.5, y: 20 });
    assert.equal(note.revision, 1);

    const replay = await store.createNote("p1", "q1", noteInput);
    assert.equal(replay.kind, "replay");
    assert.deepEqual(replay.view, created.view);

    const reused = await store.createNote("p1", "q1", { ...noteInput, text: "Другой текст" });
    assert.deepEqual(reused, { kind: "idempotency_key_reused" });

    // --- note change: authorship rules + CAS ---
    const authorChange = await store.changeNote("p1", "q1", {
      noteId: note.noteId, expectedRevision: 1, text: "Проверить фон и свет", position: { x: 11, y: 21 },
      idempotencyKey: "note-1-change", actorUserId: "author-1", actorRole: "editor"
    });
    assert.equal(authorChange.kind, "updated");
    assert.equal(authorChange.view.notes[0].text, "Проверить фон и свет");
    assert.equal(authorChange.view.notes[0].revision, 2);

    const foreignEditor = await store.changeNote("p1", "q1", {
      noteId: note.noteId, expectedRevision: 2, text: "Чужое", position: { x: 0, y: 0 },
      idempotencyKey: "note-1-foreign", actorUserId: "editor-2", actorRole: "editor"
    });
    assert.deepEqual(foreignEditor, { kind: "forbidden" });
    assert.equal((await store.getCollaboration("p1", "q1")).notes[0].text, "Проверить фон и свет");

    const ownerChange = await store.changeNote("p1", "q1", {
      noteId: note.noteId, expectedRevision: 2, text: "Правка владельца", position: { x: 12, y: 22 },
      idempotencyKey: "note-1-owner", actorUserId: "owner-9", actorRole: "owner"
    });
    assert.equal(ownerChange.kind, "updated");

    const stale = await store.changeNote("p1", "q1", {
      noteId: note.noteId, expectedRevision: 2, text: "Устаревшее", position: { x: 0, y: 0 },
      idempotencyKey: "note-1-stale", actorUserId: "author-1", actorRole: "editor"
    });
    assert.deepEqual(stale, { kind: "revision_conflict", currentRevision: 3 });

    // --- threads: create, reply, resolve/reopen, message editing ---
    const threadCreated = await store.createThread("p1", "q1", {
      anchor: { kind: "scene", targetId: "forward", position: null },
      text: "Эту сцену надо доработать",
      idempotencyKey: "thread-1", actorUserId: "author-1"
    });
    assert.equal(threadCreated.kind, "created");
    const thread = threadCreated.view.threads[0];
    assert.equal(thread.status, "open");
    assert.equal(thread.revision, 1);
    assert.deepEqual(thread.anchor, { kind: "scene", targetId: "forward", position: null });
    assert.equal(thread.anchorDeleted, false);
    assert.equal(thread.messages.length, 1);
    assert.equal(threadCreated.view.unresolvedThreadCount, 1);

    const boardThread = await store.createThread("p1", "q1", {
      anchor: { kind: "board", targetId: null, position: { x: 300, y: 400 } },
      text: "Пин на доске", idempotencyKey: "thread-2", actorUserId: "author-2"
    });
    assert.equal(boardThread.view.threads.length, 2);
    const board = boardThread.view.threads.find((entry) => entry.anchor.kind === "board");
    assert.deepEqual(board.anchor.position, { x: 300, y: 400 });

    const replied = await store.addMessage("p1", "q1", {
      threadId: thread.threadId, text: "Согласен, поправлю", idempotencyKey: "thread-1-reply", actorUserId: "author-2"
    });
    assert.equal(replied.kind, "updated");
    const repliedThread = replied.view.threads.find((entry) => entry.threadId === thread.threadId);
    assert.equal(repliedThread.messages.length, 2);
    assert.equal(repliedThread.messages[1].authorUserId, "author-2");
    assert.equal(repliedThread.revision, 2);

    const resolved = await store.setThreadStatus("p1", "q1", {
      threadId: thread.threadId, expectedRevision: 2, status: "resolved",
      idempotencyKey: "thread-1-resolve", actorUserId: "author-2"
    });
    assert.equal(resolved.kind, "updated");
    const resolvedThread = resolved.view.threads.find((entry) => entry.threadId === thread.threadId);
    assert.equal(resolvedThread.status, "resolved");
    assert.equal(typeof resolvedThread.resolvedAtMs, "number");
    assert.equal(resolved.view.unresolvedThreadCount, 1);

    const reopened = await store.setThreadStatus("p1", "q1", {
      threadId: thread.threadId, expectedRevision: 3, status: "open",
      idempotencyKey: "thread-1-reopen", actorUserId: "author-2"
    });
    const reopenedThread = reopened.view.threads.find((entry) => entry.threadId === thread.threadId);
    assert.equal(reopenedThread.status, "open");
    assert.equal(reopenedThread.resolvedAtMs, null);
    assert.equal(reopened.view.unresolvedThreadCount, 2);

    const messageId = threadCreated.view.threads[0].messages[0].messageId;
    const foreignMessageEdit = await store.changeMessage("p1", "q1", {
      threadId: thread.threadId, messageId, expectedRevision: 1, text: "Чужое сообщение",
      idempotencyKey: "msg-foreign", actorUserId: "author-2", actorRole: "editor"
    });
    assert.deepEqual(foreignMessageEdit, { kind: "forbidden" });

    const messageEdit = await store.changeMessage("p1", "q1", {
      threadId: thread.threadId, messageId, expectedRevision: 1, text: "Уточнённый текст",
      idempotencyKey: "msg-edit", actorUserId: "author-1", actorRole: "editor"
    });
    assert.equal(messageEdit.kind, "updated");
    const editedMessage = messageEdit.view.threads.find((entry) => entry.threadId === thread.threadId).messages[0];
    assert.equal(editedMessage.text, "Уточнённый текст");
    assert.equal(editedMessage.revision, 2);

    const messageDelete = await store.deleteMessage("p1", "q1", {
      threadId: thread.threadId, messageId, expectedRevision: 2,
      idempotencyKey: "msg-delete", actorUserId: "author-1", actorRole: "editor"
    });
    assert.equal(messageDelete.kind, "updated");
    const deletedMessage = messageDelete.view.threads.find((entry) => entry.threadId === thread.threadId).messages[0];
    assert.equal(deletedMessage.deleted, true);
    assert.equal(deletedMessage.text, "");
    assert.equal(messageDelete.view.threads.find((entry) => entry.threadId === thread.threadId).messages.length, 2);

    // --- deleting the anchored object keeps the discussion and marks it ---
    const draftBefore = await store.getDraft("p1", "q1");
    const removal = await store.applyDraftChanges("p1", "q1", { baseRevision: draftBefore.draftRevision, changes: [{ kind: "block.remove", blockId: "forward" }] });
    assert.equal(removal.kind, "updated");
    const afterRemoval = await store.getCollaboration("p1", "q1");
    const orphaned = afterRemoval.threads.find((entry) => entry.threadId === thread.threadId);
    assert.equal(orphaned.anchorDeleted, true);
    assert.equal(orphaned.messages.length, 2);
    assert.equal(afterRemoval.threads.find((entry) => entry.anchor.kind === "board").anchorDeleted, false);

    // --- notes/comments must not touch the gameplay content hash ---
    const draftAfter = await store.getDraft("p1", "q1");
    assert.equal(draftAfter.contentHash, removal.draft.contentHash);
    assert.equal(draftBefore.contentHash, (await store.getDraftSnapshot("p1", "q1", draftBefore.draftRevision)).contentHash);
  } finally {
    await dispose(dir, store);
  }
});

test("FIN-12 collaboration store survives close/reopen and upgrades schema v5", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = await mkdtemp(join(tmpdir(), "living-history-collaboration-restart-"));
  const path = join(dir, "control.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE control_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL); INSERT INTO control_meta VALUES ('schema_version', 5);");
  legacy.close();

  const store = new SQLiteControlStore({ path });
  await store.createProject({ projectId: "p1", title: "Проект" });
  await store.createQuest({ projectId: "p1", questId: "q1", title: "Квест", entryLocationId: "workshop", initialBlocks: [workshop] });
  const created = await store.createNote("p1", "q1", { text: "Переживёт рестарт", position: { x: 1, y: 2 }, idempotencyKey: "restart-note", actorUserId: "author-1" });
  assert.equal(created.kind, "created");
  const thread = await store.createThread("p1", "q1", { anchor: { kind: "board", targetId: null, position: { x: 5, y: 6 } }, text: "Тред", idempotencyKey: "restart-thread", actorUserId: "author-1" });
  assert.equal(thread.kind, "created");
  store.close();

  const reopened = new SQLiteControlStore({ path });
  try {
    const view = await reopened.getCollaboration("p1", "q1");
    assert.equal(view.revision, 2);
    assert.equal(view.notes[0].text, "Переживёт рестарт");
    assert.equal(view.threads[0].messages[0].text, "Тред");
    assert.equal(view.unresolvedThreadCount, 1);
  } finally {
    await dispose(dir, reopened);
  }
});
