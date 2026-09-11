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

test("FIN-12 collaboration store: note edits form an append-only revision log and deletes are soft tombstones", async () => {
  const { dir, store } = await makeStore();
  try {
    const createInput = { text: "Первая версия", position: { x: 1, y: 2 }, idempotencyKey: "rev-note-create", actorUserId: "author-1" };
    const created = await store.createNote("p1", "q1", createInput);
    assert.equal(created.kind, "created");
    assert.equal(created.view.revision, 1);
    const noteId = created.view.notes[0].noteId;
    assert.equal(created.view.notes[0].revision, 1);

    const second = await store.changeNote("p1", "q1", {
      noteId, expectedRevision: 1, text: "Вторая версия", position: { x: 5, y: 6 },
      idempotencyKey: "rev-note-2", actorUserId: "author-1", actorRole: "editor"
    });
    assert.equal(second.kind, "updated");
    assert.equal(second.view.revision, 2);
    assert.equal(second.view.notes[0].revision, 2);
    assert.equal(second.view.notes[0].text, "Вторая версия");
    assert.deepEqual(second.view.notes[0].position, { x: 5, y: 6 });

    const third = await store.changeNote("p1", "q1", {
      noteId, expectedRevision: 2, text: "Третья версия", position: { x: 7, y: 8 },
      idempotencyKey: "rev-note-3", actorUserId: "author-1", actorRole: "editor"
    });
    assert.equal(third.kind, "updated");
    assert.equal(third.view.revision, 3);
    assert.equal(third.view.notes[0].revision, 3);

    // The write log is append-only: replaying an earlier accepted write returns
    // the view of that revision, while the live view keeps the newest revision.
    const replayCreate = await store.createNote("p1", "q1", createInput);
    assert.equal(replayCreate.kind, "replay");
    assert.equal(replayCreate.view.revision, 1);
    assert.equal(replayCreate.view.notes[0].revision, 1);
    assert.equal(replayCreate.view.notes[0].text, "Первая версия");
    const replaySecond = await store.changeNote("p1", "q1", {
      noteId, expectedRevision: 1, text: "Вторая версия", position: { x: 5, y: 6 },
      idempotencyKey: "rev-note-2", actorUserId: "author-1", actorRole: "editor"
    });
    assert.equal(replaySecond.kind, "replay");
    assert.equal(replaySecond.view.notes[0].revision, 2);
    assert.equal(replaySecond.view.notes[0].text, "Вторая версия");
    assert.equal((await store.getCollaboration("p1", "q1")).notes[0].text, "Третья версия");

    // A stale base revision is rejected, never merged into the newer state.
    const stale = await store.changeNote("p1", "q1", {
      noteId, expectedRevision: 2, text: "Устаревшая", position: { x: 0, y: 0 },
      idempotencyKey: "rev-note-stale", actorUserId: "author-1", actorRole: "editor"
    });
    assert.deepEqual(stale, { kind: "revision_conflict", currentRevision: 3 });
    assert.equal((await store.getCollaboration("p1", "q1")).notes[0].text, "Третья версия");

    // Delete is a tombstone: the note leaves the live view, the revision still
    // advances, and the earlier revisions stay replayable afterwards.
    const deleted = await store.deleteNote("p1", "q1", {
      noteId, expectedRevision: 3, idempotencyKey: "rev-note-delete", actorUserId: "author-1", actorRole: "editor"
    });
    assert.equal(deleted.kind, "updated");
    assert.equal(deleted.view.revision, 4);
    assert.deepEqual(deleted.view.notes, []);
    assert.deepEqual(await store.deleteNote("p1", "q1", {
      noteId, expectedRevision: 4, idempotencyKey: "rev-note-delete-again", actorUserId: "author-1", actorRole: "editor"
    }), { kind: "not_found" });
    assert.deepEqual(await store.changeNote("p1", "q1", {
      noteId, expectedRevision: 4, text: "После удаления", position: { x: 1, y: 1 },
      idempotencyKey: "rev-note-after-delete", actorUserId: "author-1", actorRole: "editor"
    }), { kind: "not_found" });
    const replayDeleted = await store.deleteNote("p1", "q1", {
      noteId, expectedRevision: 3, idempotencyKey: "rev-note-delete", actorUserId: "author-1", actorRole: "editor"
    });
    assert.equal(replayDeleted.kind, "replay");
    assert.equal(replayDeleted.view.revision, 4);
    const replayThird = await store.changeNote("p1", "q1", {
      noteId, expectedRevision: 2, text: "Третья версия", position: { x: 7, y: 8 },
      idempotencyKey: "rev-note-3", actorUserId: "author-1", actorRole: "editor"
    });
    assert.equal(replayThird.kind, "replay");
    assert.equal(replayThird.view.notes[0].revision, 3);
    assert.equal(replayThird.view.notes[0].text, "Третья версия");
  } finally {
    await dispose(dir, store);
  }
});

test("FIN-12 collaboration store: replies attach to their thread and unknown/cross-thread ids are rejected", async () => {
  const { dir, store } = await makeStore();
  try {
    const first = await store.createThread("p1", "q1", {
      anchor: { kind: "scene", targetId: "forward", position: null },
      text: "Тред A", idempotencyKey: "th-a", actorUserId: "author-1"
    });
    assert.equal(first.kind, "created");
    const second = await store.createThread("p1", "q1", {
      anchor: { kind: "board", targetId: null, position: { x: 10, y: 20 } },
      text: "Тред B", idempotencyKey: "th-b", actorUserId: "author-2"
    });
    const threadA = first.view.threads.find((entry) => entry.anchor.kind === "scene");
    const threadB = second.view.threads.find((entry) => entry.anchor.kind === "board");
    assert.equal(threadA.messages[0].authorUserId, "author-1");
    assert.equal(threadB.messages[0].authorUserId, "author-2");

    // A reply lands in the addressed thread only and records its own author.
    const reply = await store.addMessage("p1", "q1", {
      threadId: threadA.threadId, text: "Ответ в A", idempotencyKey: "th-a-reply", actorUserId: "author-3"
    });
    assert.equal(reply.kind, "updated");
    const aAfter = reply.view.threads.find((entry) => entry.threadId === threadA.threadId);
    const bAfter = reply.view.threads.find((entry) => entry.threadId === threadB.threadId);
    assert.equal(aAfter.messages.length, 2);
    assert.equal(aAfter.messages[1].text, "Ответ в A");
    assert.equal(aAfter.messages[1].authorUserId, "author-3");
    assert.equal(aAfter.messages[1].revision, 1);
    assert.equal(aAfter.revision, threadA.revision + 1);
    assert.equal(bAfter.messages.length, 1);
    assert.equal(bAfter.revision, threadB.revision);

    // A reply to a message/thread that does not exist is rejected, not attached.
    assert.deepEqual(await store.addMessage("p1", "q1", {
      threadId: "thread-404", text: "нет треда", idempotencyKey: "th-missing", actorUserId: "author-1"
    }), { kind: "not_found" });
    const messageA = aAfter.messages[0].messageId;
    assert.deepEqual(await store.changeMessage("p1", "q1", {
      threadId: threadA.threadId, messageId: "message-404", expectedRevision: 1, text: "нет сообщения",
      idempotencyKey: "msg-missing", actorUserId: "author-1", actorRole: "editor"
    }), { kind: "not_found" });
    assert.deepEqual(await store.deleteMessage("p1", "q1", {
      threadId: threadA.threadId, messageId: "message-404", expectedRevision: 1,
      idempotencyKey: "msg-missing-delete", actorUserId: "author-1", actorRole: "editor"
    }), { kind: "not_found" });
    // A real message id addressed under the wrong thread is rejected too.
    assert.deepEqual(await store.changeMessage("p1", "q1", {
      threadId: threadB.threadId, messageId: messageA, expectedRevision: 1, text: "чужой тред",
      idempotencyKey: "msg-wrong-thread", actorUserId: "author-1", actorRole: "editor"
    }), { kind: "not_found" });
    assert.deepEqual(await store.changeMessage("p1", "q1", {
      threadId: "thread-404", messageId: messageA, expectedRevision: 1, text: "нет треда",
      idempotencyKey: "msg-ghost-thread", actorUserId: "author-1", actorRole: "editor"
    }), { kind: "not_found" });

    // Message edits are CAS- and authorship-guarded.
    assert.deepEqual(await store.changeMessage("p1", "q1", {
      threadId: threadA.threadId, messageId: messageA, expectedRevision: 5, text: "устарело",
      idempotencyKey: "msg-stale", actorUserId: "author-1", actorRole: "editor"
    }), { kind: "revision_conflict", currentRevision: 1 });
    assert.deepEqual(await store.changeMessage("p1", "q1", {
      threadId: threadA.threadId, messageId: messageA, expectedRevision: 1, text: "чужое",
      idempotencyKey: "msg-foreign", actorUserId: "author-9", actorRole: "editor"
    }), { kind: "forbidden" });
    const own = await store.changeMessage("p1", "q1", {
      threadId: threadA.threadId, messageId: messageA, expectedRevision: 1, text: "свой текст",
      idempotencyKey: "msg-own", actorUserId: "author-1", actorRole: "editor"
    });
    assert.equal(own.kind, "updated");
    assert.equal(own.view.threads.find((entry) => entry.threadId === threadA.threadId).messages[0].text, "свой текст");

    // Soft delete keeps the slot so thread order and count stay honest.
    const beforeDelete = own.view.threads.find((entry) => entry.threadId === threadA.threadId);
    const removed = await store.deleteMessage("p1", "q1", {
      threadId: threadA.threadId, messageId: messageA, expectedRevision: 2,
      idempotencyKey: "msg-delete", actorUserId: "author-1", actorRole: "editor"
    });
    assert.equal(removed.kind, "updated");
    const afterDelete = removed.view.threads.find((entry) => entry.threadId === threadA.threadId);
    assert.equal(afterDelete.messages.length, beforeDelete.messages.length);
    assert.equal(afterDelete.messages[0].messageId, messageA);
    assert.equal(afterDelete.messages[0].deleted, true);
    assert.equal(afterDelete.messages[0].text, "");
    assert.equal(afterDelete.revision, beforeDelete.revision + 1);
    assert.equal(afterDelete.messages[1].deleted, false);
    assert.deepEqual(await store.changeMessage("p1", "q1", {
      threadId: threadA.threadId, messageId: messageA, expectedRevision: 2, text: "после удаления",
      idempotencyKey: "msg-after-delete", actorUserId: "author-1", actorRole: "editor"
    }), { kind: "not_found" });
    assert.deepEqual(await store.deleteMessage("p1", "q1", {
      threadId: threadA.threadId, messageId: messageA, expectedRevision: 2,
      idempotencyKey: "msg-delete-again", actorUserId: "author-1", actorRole: "editor"
    }), { kind: "not_found" });
  } finally {
    await dispose(dir, store);
  }
});

test("FIN-12 collaboration store: thread status is a CAS state machine over open/resolved and rejects invalid states", async () => {
  const { dir, store } = await makeStore();
  try {
    const opened = await store.createThread("p1", "q1", {
      anchor: { kind: "board", targetId: null, position: { x: 1, y: 1 } },
      text: "Открытый тред", idempotencyKey: "state-open", actorUserId: "author-1"
    });
    const threadId = opened.view.threads[0].threadId;
    assert.equal(opened.view.threads[0].status, "open");
    assert.equal(opened.view.unresolvedThreadCount, 1);

    assert.deepEqual(await store.setThreadStatus("p1", "q1", {
      threadId, expectedRevision: 5, status: "resolved", idempotencyKey: "state-stale-1", actorUserId: "author-1"
    }), { kind: "revision_conflict", currentRevision: 1 });
    const invalid = await store.setThreadStatus("p1", "q1", {
      threadId, expectedRevision: 1, status: "closed", idempotencyKey: "state-invalid", actorUserId: "author-1"
    });
    assert.equal(invalid.kind, "invalid_request");
    assert.deepEqual(invalid.errors, ["status"]);
    assert.deepEqual(await store.setThreadStatus("p1", "q1", {
      threadId: "thread-404", expectedRevision: 1, status: "resolved", idempotencyKey: "state-missing", actorUserId: "author-1"
    }), { kind: "not_found" });

    const resolved = await store.setThreadStatus("p1", "q1", {
      threadId, expectedRevision: 1, status: "resolved", idempotencyKey: "state-resolve", actorUserId: "author-1"
    });
    assert.equal(resolved.kind, "updated");
    let thread = resolved.view.threads[0];
    assert.equal(thread.status, "resolved");
    assert.equal(Number.isFinite(thread.resolvedAtMs), true);
    assert.equal(thread.revision, 2);
    assert.equal(resolved.view.unresolvedThreadCount, 0);

    assert.deepEqual(await store.setThreadStatus("p1", "q1", {
      threadId, expectedRevision: 1, status: "open", idempotencyKey: "state-stale-2", actorUserId: "author-1"
    }), { kind: "revision_conflict", currentRevision: 2 });

    const reopened = await store.setThreadStatus("p1", "q1", {
      threadId, expectedRevision: 2, status: "open", idempotencyKey: "state-reopen", actorUserId: "author-2"
    });
    assert.equal(reopened.kind, "updated");
    thread = reopened.view.threads[0];
    assert.equal(thread.status, "open");
    assert.equal(thread.resolvedAtMs, null);
    assert.equal(thread.revision, 3);
    assert.equal(reopened.view.unresolvedThreadCount, 1);

    // A status change never drops the discussion.
    assert.equal(thread.messages.length, 1);
    assert.equal((await store.getCollaboration("p1", "q1")).threads[0].status, "open");
  } finally {
    await dispose(dir, store);
  }
});

test("FIN-12 collaboration store: unknown ids and a foreign quest stay not_found instead of silently creating", async () => {
  const { dir, store } = await makeStore();
  try {
    assert.equal(await store.getCollaboration("p1", "missing-quest"), null);
    assert.equal(await store.getCollaboration("missing-project", "q1"), null);

    assert.deepEqual(await store.changeNote("p1", "q1", {
      noteId: "note-404", expectedRevision: 1, text: "x", position: { x: 1, y: 1 },
      idempotencyKey: "u-note-change", actorUserId: "author-1", actorRole: "editor"
    }), { kind: "not_found" });
    assert.deepEqual(await store.deleteNote("p1", "q1", {
      noteId: "note-404", expectedRevision: 1, idempotencyKey: "u-note-delete", actorUserId: "author-1", actorRole: "editor"
    }), { kind: "not_found" });
    assert.deepEqual(await store.addMessage("p1", "q1", {
      threadId: "thread-404", text: "x", idempotencyKey: "u-reply", actorUserId: "author-1"
    }), { kind: "not_found" });
    assert.deepEqual(await store.changeMessage("p1", "q1", {
      threadId: "thread-404", messageId: "message-404", expectedRevision: 1, text: "x",
      idempotencyKey: "u-msg-change", actorUserId: "author-1", actorRole: "editor"
    }), { kind: "not_found" });
    assert.deepEqual(await store.deleteMessage("p1", "q1", {
      threadId: "thread-404", messageId: "message-404", expectedRevision: 1,
      idempotencyKey: "u-msg-delete", actorUserId: "author-1", actorRole: "editor"
    }), { kind: "not_found" });
    assert.deepEqual(await store.setThreadStatus("p1", "q1", {
      threadId: "thread-404", expectedRevision: 1, status: "resolved", idempotencyKey: "u-status", actorUserId: "author-1"
    }), { kind: "not_found" });

    // A real note id belongs to one quest: the same id in a sibling quest is
    // simply unknown, and neither quest is mutated.
    await store.createQuest({ projectId: "p1", questId: "q2", title: "Квест 2", entryLocationId: "forward", initialBlocks: [workshop, forward] });
    const made = await store.createNote("p1", "q1", {
      text: "живая", position: { x: 1, y: 1 }, idempotencyKey: "u-note", actorUserId: "author-1"
    });
    const noteId = made.view.notes[0].noteId;
    assert.deepEqual(await store.changeNote("p1", "q2", {
      noteId, expectedRevision: 1, text: "чужой квест", position: { x: 1, y: 1 },
      idempotencyKey: "u-cross-quest", actorUserId: "author-1", actorRole: "editor"
    }), { kind: "not_found" });
    assert.equal((await store.getCollaboration("p1", "q1")).notes[0].text, "живая");
    assert.deepEqual((await store.getCollaboration("p1", "q2")).notes, []);
    assert.equal((await store.getCollaboration("p1", "q2")).revision, 0);
  } finally {
    await dispose(dir, store);
  }
});
