import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteControlStore } from "../dist/index.js";

const workshop = Object.freeze({ schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: Object.freeze({}) });
const forward = Object.freeze({ schemaVersion: "1.0", id: "forward", kind: "core.location", title: "Вперёд", description: "", data: Object.freeze({}) });

async function makeStore(prefix = "living-history-fin12-parent-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
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
  try { store.close(); } catch { /* already closed */ }
  await rm(dir, { recursive: true, force: true });
}

const messageIds = (thread) => thread.messages.map((message) => message.messageId);

test("FIN-12 message parent: a reply is linked to its parent in the file database and survives reopen", async () => {
  const { dir, path, store } = await makeStore("living-history-fin12-parent-persist-");
  try {
    const created = await store.createThread("p1", "q1", {
      anchor: { kind: "scene", targetId: "forward", position: null },
      text: "Открывающее сообщение",
      idempotencyKey: "parent-thread",
      actorUserId: "author-1"
    });
    assert.equal(created.kind, "created");
    const threadId = created.view.threads[0].threadId;
    const rootId = created.view.threads[0].messages[0].messageId;
    // The opening message of a thread has no parent.
    assert.equal(created.view.threads[0].messages[0].replyToMessageId, null);

    const reply = await store.addMessage("p1", "q1", {
      threadId,
      text: "Ответ на конкретное сообщение",
      replyToMessageId: rootId,
      idempotencyKey: "parent-reply",
      actorUserId: "author-2"
    });
    assert.equal(reply.kind, "updated");
    const repliedThread = reply.view.threads.find((entry) => entry.threadId === threadId);
    assert.equal(repliedThread.messages.length, 2);
    assert.equal(repliedThread.messages[1].replyToMessageId, rootId);
    assert.equal(repliedThread.messages[0].replyToMessageId, null);

    // A flat reply (no parent supplied) stays a top-level message.
    const flat = await store.addMessage("p1", "q1", {
      threadId,
      text: "Без родителя",
      idempotencyKey: "parent-flat",
      actorUserId: "author-2"
    });
    assert.equal(flat.kind, "updated");
    const flatThread = flat.view.threads.find((entry) => entry.threadId === threadId);
    assert.equal(flatThread.messages[2].replyToMessageId, null);

    // The link is really a column in the file, not a value kept in memory.
    store.close();
    const raw = new DatabaseSync(path);
    try {
      const columns = raw.prepare("PRAGMA table_info(control_collaboration_messages)").all().map((column) => String(column.name));
      assert.ok(columns.includes("parent_message_id"), `parent_message_id missing from ${columns.join(",")}`);
      const rows = raw.prepare(`
        SELECT message_id, parent_message_id FROM control_collaboration_messages
        WHERE project_id = 'p1' AND quest_id = 'q1' AND thread_id = ? ORDER BY message_id
      `).all(threadId);
      assert.equal(rows.length, 3);
      assert.equal(String(rows[1].parent_message_id), rootId);
      assert.equal(rows[0].parent_message_id, null);
      assert.equal(rows[2].parent_message_id, null);
    } finally {
      raw.close();
    }

    const reopened = new SQLiteControlStore({ path });
    try {
      const view = await reopened.getCollaboration("p1", "q1");
      const thread = view.threads.find((entry) => entry.threadId === threadId);
      assert.deepEqual(messageIds(thread), ["message-1", "message-2", "message-3"]);
      assert.equal(thread.messages[1].replyToMessageId, rootId);
      assert.equal(thread.messages[0].replyToMessageId, null);
    } finally {
      reopened.close();
    }
  } finally {
    await dispose(dir, store);
  }
});

test("FIN-12 message parent: unknown, cross-thread and tombstone parents are invalid_request and write nothing", async () => {
  const { dir, store } = await makeStore("living-history-fin12-parent-reject-");
  try {
    const first = await store.createThread("p1", "q1", {
      anchor: { kind: "scene", targetId: "forward", position: null },
      text: "Тред А",
      idempotencyKey: "reject-thread-a",
      actorUserId: "author-1"
    });
    const threadA = first.view.threads[0].threadId;
    const rootA = first.view.threads[0].messages[0].messageId;

    const second = await store.createThread("p1", "q1", {
      anchor: { kind: "board", targetId: null, position: { x: 10, y: 10 } },
      text: "Тред Б",
      idempotencyKey: "reject-thread-b",
      actorUserId: "author-1"
    });
    const threadB = second.view.threads.find((entry) => entry.anchor.kind === "board").threadId;

    const before = await store.getCollaboration("p1", "q1");

    // A parent that does not exist at all.
    const unknown = await store.addMessage("p1", "q1", {
      threadId: threadA,
      text: "Ответ в никуда",
      replyToMessageId: "message-does-not-exist",
      idempotencyKey: "reject-unknown-parent",
      actorUserId: "author-2"
    });
    assert.equal(unknown.kind, "invalid_request");
    assert.deepEqual(unknown.errors, ["replyToMessageId"]);

    // A parent that exists, but in another thread of the same quest.
    const crossThread = await store.addMessage("p1", "q1", {
      threadId: threadB,
      text: "Ответ не в тот тред",
      replyToMessageId: rootA,
      idempotencyKey: "reject-cross-thread-parent",
      actorUserId: "author-2"
    });
    assert.equal(crossThread.kind, "invalid_request");
    assert.deepEqual(crossThread.errors, ["replyToMessageId"]);

    // A malformed parent id never reaches the database.
    const malformed = await store.addMessage("p1", "q1", {
      threadId: threadA,
      text: "Кривой родитель",
      replyToMessageId: "not a valid id!",
      idempotencyKey: "reject-malformed-parent",
      actorUserId: "author-2"
    });
    assert.equal(malformed.kind, "invalid_request");
    assert.deepEqual(malformed.errors, ["replyToMessageId"]);

    // A tombstone (soft-deleted) parent is a structural dead end.
    const messageA = before.threads.find((entry) => entry.threadId === threadA).messages[0];
    const deleted = await store.deleteMessage("p1", "q1", {
      threadId: threadA,
      messageId: rootA,
      expectedRevision: messageA.revision,
      idempotencyKey: "reject-parent-delete",
      actorUserId: "author-1",
      actorRole: "editor"
    });
    assert.equal(deleted.kind, "updated");
    const afterDelete = await store.getCollaboration("p1", "q1");
    const tombstone = await store.addMessage("p1", "q1", {
      threadId: threadA,
      text: "Ответ на удалённое",
      replyToMessageId: rootA,
      idempotencyKey: "reject-tombstone-parent",
      actorUserId: "author-2"
    });
    assert.equal(tombstone.kind, "invalid_request");
    assert.deepEqual(tombstone.errors, ["replyToMessageId"]);

    // A rejected reply writes nothing: no new message, no thread revision, no
    // collection revision, and the rejected idempotency key is not consumed.
    const afterRejects = await store.getCollaboration("p1", "q1");
    assert.equal(afterRejects.threads.find((entry) => entry.threadId === threadA).messages.length, 1);
    assert.equal(afterRejects.threads.find((entry) => entry.threadId === threadB).messages.length, 1);
    assert.equal(afterRejects.threads.find((entry) => entry.threadId === threadA).revision, afterDelete.threads.find((entry) => entry.threadId === threadA).revision);
    assert.equal(afterRejects.revision, afterDelete.revision);

    // The same key is still usable for a corrected retry of the same request.
    const retry = await store.addMessage("p1", "q1", {
      threadId: threadA,
      text: "Ответ на удалённое",
      replyToMessageId: rootA,
      idempotencyKey: "reject-tombstone-parent",
      actorUserId: "author-2"
    });
    assert.equal(retry.kind, "invalid_request");
    const corrected = await store.addMessage("p1", "q1", {
      threadId: threadB,
      text: "Ответ на удалённое",
      replyToMessageId: rootA,
      idempotencyKey: "reject-tombstone-parent",
      actorUserId: "author-2"
    });
    assert.equal(corrected.kind, "invalid_request");

    // A brand-new thread cannot open with a reply: it has no sibling to answer.
    const threadWithParent = await store.createThread("p1", "q1", {
      anchor: { kind: "board", targetId: null, position: { x: 20, y: 20 } },
      text: "Тред с родителем",
      replyToMessageId: rootA,
      idempotencyKey: "reject-thread-with-parent",
      actorUserId: "author-1"
    });
    assert.equal(threadWithParent.kind, "invalid_request");
    assert.deepEqual(threadWithParent.errors, ["replyToMessageId"]);
    assert.equal((await store.getCollaboration("p1", "q1")).threads.length, 2);
  } finally {
    await dispose(dir, store);
  }
});

// The exact pre-FIN-12 DDL: no parent_message_id column anywhere. Building the
// old file by hand is the honest way to prove the upgrade path, since the old
// code is no longer around to produce it.
const LEGACY_DDL = `
  CREATE TABLE control_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT;
  CREATE TABLE control_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL) STRICT;
  CREATE TABLE control_quests (
    project_id TEXT NOT NULL REFERENCES control_projects(project_id),
    quest_id TEXT NOT NULL,
    current_revision INTEGER NOT NULL CHECK (current_revision >= 0),
    PRIMARY KEY (project_id, quest_id)
  ) STRICT;
  CREATE TABLE control_collaboration_state (
    project_id TEXT NOT NULL,
    quest_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    PRIMARY KEY (project_id, quest_id),
    FOREIGN KEY (project_id, quest_id) REFERENCES control_quests(project_id, quest_id)
  ) STRICT;
  CREATE TABLE control_collaboration_threads (
    project_id TEXT NOT NULL,
    quest_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    anchor_kind TEXT NOT NULL CHECK (anchor_kind IN ('board','scene','layer','field')),
    target_id TEXT NULL,
    position_x REAL NULL,
    position_y REAL NULL,
    status TEXT NOT NULL CHECK (status IN ('open','resolved')),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_by_user_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    resolved_at_ms INTEGER NULL,
    PRIMARY KEY (project_id, quest_id, thread_id),
    FOREIGN KEY (project_id, quest_id) REFERENCES control_quests(project_id, quest_id)
  ) STRICT;
  CREATE TABLE control_collaboration_messages (
    project_id TEXT NOT NULL,
    quest_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    author_user_id TEXT NOT NULL,
    text TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    deleted_at_ms INTEGER NULL,
    PRIMARY KEY (project_id, quest_id, thread_id, message_id),
    FOREIGN KEY (project_id, quest_id, thread_id)
      REFERENCES control_collaboration_threads(project_id, quest_id, thread_id)
  ) STRICT;
  CREATE TABLE control_collaboration_idempotency (
    project_id TEXT NOT NULL,
    quest_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (project_id, quest_id, idempotency_key),
    FOREIGN KEY (project_id, quest_id) REFERENCES control_quests(project_id, quest_id)
  ) STRICT;
  INSERT INTO control_meta (key, value) VALUES ('schema_version', 5);
  INSERT INTO control_projects (project_id, title) VALUES ('p1', 'Старый проект');
  INSERT INTO control_quests (project_id, quest_id, current_revision) VALUES ('p1', 'q1', 7);
  INSERT INTO control_collaboration_state (project_id, quest_id, revision) VALUES ('p1', 'q1', 2);
  INSERT INTO control_collaboration_threads
    (project_id, quest_id, thread_id, anchor_kind, target_id, position_x, position_y, status, revision, created_by_user_id, created_at_ms, updated_at_ms, resolved_at_ms)
    VALUES ('p1', 'q1', 'thread-1', 'scene', 'forward', NULL, NULL, 'open', 2, 'author-1', 1000, 1001, NULL);
  INSERT INTO control_collaboration_messages
    (project_id, quest_id, thread_id, message_id, author_user_id, text, revision, created_at_ms, updated_at_ms, deleted_at_ms)
    VALUES ('p1', 'q1', 'thread-1', 'message-1', 'author-1', 'До миграции', 1, 1000, 1000, NULL);
  INSERT INTO control_collaboration_messages
    (project_id, quest_id, thread_id, message_id, author_user_id, text, revision, created_at_ms, updated_at_ms, deleted_at_ms)
    VALUES ('p1', 'q1', 'thread-1', 'message-2', 'author-2', 'Старый ответ', 1, 1001, 1001, NULL);
`;

test("FIN-12 message parent: a pre-parent file database opens, migrates to v6 and loses no rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-fin12-parent-legacy-"));
  const path = join(dir, "control.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(LEGACY_DDL);
  legacy.close();

  // Sanity: the file really is the old shape before the store touches it.
  const before = new DatabaseSync(path);
  const beforeColumns = before.prepare("PRAGMA table_info(control_collaboration_messages)").all().map((column) => String(column.name));
  assert.equal(beforeColumns.includes("parent_message_id"), false);
  assert.equal(Number(before.prepare("SELECT value FROM control_meta WHERE key = 'schema_version'").get().value), 5);
  assert.equal(Number(before.prepare("SELECT COUNT(*) AS n FROM control_collaboration_messages").get().n), 2);
  before.close();

  const store = new SQLiteControlStore({ path });
  let migrated;
  try {
    // Opening the store is the migration; the rows must be reachable.
    migrated = await store.getCollaboration("p1", "q1");
    assert.equal(migrated.revision, 2);
    assert.equal(migrated.threads.length, 1);
    const thread = migrated.threads[0];
    assert.equal(thread.threadId, "thread-1");
    assert.equal(thread.messages.length, 2);
    assert.deepEqual(thread.messages.map((message) => message.messageId), ["message-1", "message-2"]);
    assert.deepEqual(thread.messages.map((message) => message.text), ["До миграции", "Старый ответ"]);
    assert.deepEqual(thread.messages.map((message) => message.replyToMessageId), [null, null]);

    // A migrated message can now answer the pre-existing one.
    const reply = await store.addMessage("p1", "q1", {
      threadId: "thread-1",
      text: "Ответ после миграции",
      replyToMessageId: "message-1",
      idempotencyKey: "legacy-reply",
      actorUserId: "author-3"
    });
    assert.equal(reply.kind, "updated");
    const updated = reply.view.threads[0];
    assert.equal(updated.messages.length, 3);
    assert.equal(updated.messages[2].replyToMessageId, "message-1");
  } finally {
    store.close();
  }

  // The migrated file: column added, version bumped, all rows kept, composite
  // parent foreign key installed.
  const after = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  try {
    const columns = after.prepare("PRAGMA table_info(control_collaboration_messages)").all().map((column) => String(column.name));
    assert.ok(columns.includes("parent_message_id"));
    assert.equal(Number(after.prepare("SELECT value FROM control_meta WHERE key = 'schema_version'").get().value), 6);
    assert.equal(Number(after.prepare("SELECT COUNT(*) AS n FROM control_collaboration_messages").get().n), 3);
    const foreignKeys = after.prepare("PRAGMA foreign_key_list(control_collaboration_messages)").all();
    const parentKey = foreignKeys.find((key) => String(key.table) === "control_collaboration_messages" && String(key.from) === "parent_message_id");
    assert.ok(parentKey, "composite parent foreign key missing after migration");
    assert.equal(String(parentKey.to), "message_id");
    // Structural enforcement at the database level: the composite key makes a
    // missing parent, or a parent from another thread, impossible to store.
    assert.throws(() => {
      after.exec(`
        INSERT INTO control_collaboration_messages
          (project_id, quest_id, thread_id, message_id, author_user_id, text, revision, created_at_ms, updated_at_ms, deleted_at_ms, parent_message_id)
        VALUES ('p1', 'q1', 'thread-1', 'message-bad-1', 'author-3', 'x', 1, 1, 1, NULL, 'message-does-not-exist')
      `);
    }, /FOREIGN KEY constraint failed/);
    after.exec(`
      INSERT INTO control_collaboration_threads
        (project_id, quest_id, thread_id, anchor_kind, target_id, position_x, position_y, status, revision, created_by_user_id, created_at_ms, updated_at_ms, resolved_at_ms)
      VALUES ('p1', 'q1', 'thread-2', 'board', NULL, 1, 1, 'open', 1, 'author-3', 1, 1, NULL)
    `);
    assert.throws(() => {
      after.exec(`
        INSERT INTO control_collaboration_messages
          (project_id, quest_id, thread_id, message_id, author_user_id, text, revision, created_at_ms, updated_at_ms, deleted_at_ms, parent_message_id)
        VALUES ('p1', 'q1', 'thread-2', 'message-bad-2', 'author-3', 'x', 1, 1, 1, NULL, 'message-1')
      `);
    }, /FOREIGN KEY constraint failed/);
  } finally {
    after.close();
  }

  // Reopening the migrated file changes nothing further.
  const reopened = new SQLiteControlStore({ path });
  try {
    const view = await reopened.getCollaboration("p1", "q1");
    const thread = view.threads.find((entry) => entry.threadId === "thread-1");
    assert.equal(thread.messages.length, 3);
    assert.equal(thread.messages[2].replyToMessageId, "message-1");
  } finally {
    await dispose(dir, reopened);
  }
});
