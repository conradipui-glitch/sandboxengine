import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  COLLABORATION_REPLY_POLICY,
  SQLiteControlStore,
  flattenReplyTarget,
  resolveThreadRoot,
  withReplyPolicy
} from "../dist/index.js";

const workshop = Object.freeze({ schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: Object.freeze({}) });
const forward = Object.freeze({ schemaVersion: "1.0", id: "forward", kind: "core.location", title: "Вперёд", description: "", data: Object.freeze({}) });

async function makeStore(prefix = "living-history-fin12-replies-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const path = join(dir, "control.sqlite");
  const inner = new SQLiteControlStore({ path });
  await inner.createProject({ projectId: "p1", title: "Проект" });
  await inner.createQuest({
    projectId: "p1",
    questId: "q1",
    title: "Квест",
    entryLocationId: "workshop",
    initialBlocks: [workshop, forward]
  });
  return { dir, path, inner, store: withReplyPolicy(inner) };
}

async function dispose(dir, store) {
  try { store.close(); } catch { /* already closed */ }
  await rm(dir, { recursive: true, force: true });
}

const threadOf = (view, threadId) => view.threads.find((entry) => entry.threadId === threadId);
const makeMessage = (messageId, replyToMessageId) => Object.freeze({
  messageId,
  authorUserId: "author-1",
  text: `msg ${messageId}`,
  replyToMessageId,
  revision: 1,
  createdAtMs: 1,
  updatedAtMs: 1,
  deleted: false
});

test("FIN-12 reply policy: the chosen policy is flat threads anchored to the root", () => {
  assert.equal(COLLABORATION_REPLY_POLICY, "flatten-to-root");
});

test("FIN-12 reply policy: resolveThreadRoot walks any chain, survives cycles and unknown ids", () => {
  const flat = [makeMessage("message-1", null), makeMessage("message-2", "message-1")];
  assert.equal(resolveThreadRoot(flat, "message-1"), "message-1");
  assert.equal(resolveThreadRoot(flat, "message-2"), "message-1");
  assert.equal(flattenReplyTarget(flat, undefined), undefined);
  assert.equal(flattenReplyTarget(flat, "message-1"), "message-1");
  assert.equal(flattenReplyTarget(flat, "message-2"), "message-1");
  // An unknown id is handed back unchanged so the store keeps the verdict.
  assert.equal(flattenReplyTarget(flat, "message-404"), "message-404");
  assert.equal(resolveThreadRoot(flat, "message-404"), null);

  // A legacy nested chain (written while the link was optional) still flattens
  // to its true root.
  const nested = [makeMessage("message-1", null), makeMessage("message-2", "message-1"), makeMessage("message-3", "message-2")];
  assert.equal(resolveThreadRoot(nested, "message-3"), "message-1");
  assert.equal(flattenReplyTarget(nested, "message-3"), "message-1");

  // A defensive cycle guard never loops forever.
  const cyclic = [makeMessage("message-1", "message-2"), makeMessage("message-2", "message-1")];
  assert.equal(typeof resolveThreadRoot(cyclic, "message-1"), "string");
});

test("FIN-12 reply CAS: a reply without a base revision is invalid_request and writes nothing", async () => {
  const { dir, path, inner, store } = await makeStore("living-history-fin12-replies-cas-required-");
  try {
    const opened = await store.createThread("p1", "q1", {
      anchor: { kind: "board", targetId: null, position: { x: 1, y: 1 } },
      text: "Тред", idempotencyKey: "req-thread", actorUserId: "author-1"
    });
    const threadId = opened.view.threads[0].threadId;

    const noBase = await store.addMessage("p1", "q1", {
      threadId, text: "Без базовой ревизии", idempotencyKey: "req-reply", actorUserId: "author-2"
    });
    assert.equal(noBase.kind, "invalid_request");
    assert.deepEqual(noBase.errors, ["expectedRevision"]);

    const after = await store.getCollaboration("p1", "q1");
    assert.equal(threadOf(after, threadId).messages.length, 1);
    assert.equal(threadOf(after, threadId).revision, 1);
    assert.equal(after.revision, 1);

    // The rejected key was not consumed: the corrected retry lands.
    const corrected = await store.addMessage("p1", "q1", {
      threadId, text: "Без базовой ревизии", expectedRevision: 1,
      idempotencyKey: "req-reply", actorUserId: "author-2"
    });
    assert.equal(corrected.kind, "updated");
    assert.equal(threadOf(corrected.view, threadId).messages.length, 2);

    // A file-level cross-check: the wrapper did not smuggle a write through.
    inner.close();
    const raw = new DatabaseSync(path);
    try {
      const count = Number(raw.prepare("SELECT COUNT(*) AS n FROM control_collaboration_messages").get().n);
      assert.equal(count, 2);
    } finally {
      raw.close();
    }
  } finally {
    await dispose(dir, inner);
  }
});

test("FIN-12 reply CAS: a stale base is revision_conflict with the live revision and no reply is lost", async () => {
  const { dir, inner, store } = await makeStore("living-history-fin12-replies-cas-lost-");
  try {
    const opened = await store.createThread("p1", "q1", {
      anchor: { kind: "board", targetId: null, position: { x: 2, y: 2 } },
      text: "Живой тред", idempotencyKey: "lost-thread", actorUserId: "author-1"
    });
    const threadId = opened.view.threads[0].threadId;
    const rootId = opened.view.threads[0].messages[0].messageId;
    assert.equal(opened.view.threads[0].revision, 1);

    // Two authors both read base revision 1 and answer at the same time.
    const first = await store.addMessage("p1", "q1", {
      threadId, text: "Ответ А", replyToMessageId: rootId, expectedRevision: 1,
      idempotencyKey: "lost-a", actorUserId: "author-2"
    });
    assert.equal(first.kind, "updated");
    assert.equal(threadOf(first.view, threadId).revision, 2);

    const stale = await store.addMessage("p1", "q1", {
      threadId, text: "Ответ Б", replyToMessageId: rootId, expectedRevision: 1,
      idempotencyKey: "lost-b", actorUserId: "author-3"
    });
    assert.deepEqual(stale, { kind: "revision_conflict", currentRevision: 2 });

    // The loser is not dropped: the rejected key is reusable at the fresh base.
    const retried = await store.addMessage("p1", "q1", {
      threadId, text: "Ответ Б", replyToMessageId: rootId, expectedRevision: 2,
      idempotencyKey: "lost-b-retry", actorUserId: "author-3"
    });
    assert.equal(retried.kind, "updated");
    const thread = threadOf(retried.view, threadId);
    assert.equal(thread.revision, 3);
    assert.equal(thread.messages.length, 3);
    assert.deepEqual(thread.messages.map((message) => message.text), ["Живой тред", "Ответ А", "Ответ Б"]);
    assert.equal(retried.view.revision, 3);
  } finally {
    await dispose(dir, inner);
  }
});

test("FIN-12 reply policy: a reply to a reply is anchored to the thread root, in memory and in the file", async () => {
  const { dir, path, inner, store } = await makeStore("living-history-fin12-replies-flatten-");
  try {
    const opened = await store.createThread("p1", "q1", {
      anchor: { kind: "board", targetId: null, position: { x: 3, y: 3 } },
      text: "Корень", idempotencyKey: "flat-thread", actorUserId: "author-1"
    });
    const threadId = opened.view.threads[0].threadId;
    const rootId = opened.view.threads[0].messages[0].messageId;

    const reply = await store.addMessage("p1", "q1", {
      threadId, text: "Первый ответ", replyToMessageId: rootId, expectedRevision: 1,
      idempotencyKey: "flat-reply", actorUserId: "author-2"
    });
    const replyId = threadOf(reply.view, threadId).messages[1].messageId;
    assert.equal(threadOf(reply.view, threadId).messages[1].replyToMessageId, rootId);

    // Answering the answer: the stored parent is the root, not the intermediate.
    const nested = await store.addMessage("p1", "q1", {
      threadId, text: "Ответ на ответ", replyToMessageId: replyId, expectedRevision: 2,
      idempotencyKey: "flat-nested", actorUserId: "author-3"
    });
    assert.equal(nested.kind, "updated");
    const second = threadOf(nested.view, threadId).messages[2];
    assert.equal(second.replyToMessageId, rootId, "reply-to-reply must be flattened to the root");
    assert.notEqual(second.replyToMessageId, replyId);
    // Nothing is lost: all three messages stay, order included.
    assert.deepEqual(threadOf(nested.view, threadId).messages.map((message) => message.messageId), ["message-1", "message-2", "message-3"]);

    // A MALFORMED parent still reaches the store's own verdict.
    const unknown = await store.addMessage("p1", "q1", {
      threadId, text: "В никуда", replyToMessageId: "message-404", expectedRevision: 3,
      idempotencyKey: "flat-unknown", actorUserId: "author-3"
    });
    assert.equal(unknown.kind, "invalid_request");
    assert.deepEqual(unknown.errors, ["replyToMessageId"]);

    inner.close();
    const raw = new DatabaseSync(path);
    let storedParent;
    try {
      storedParent = raw.prepare(
        "SELECT parent_message_id FROM control_collaboration_messages WHERE project_id = 'p1' AND quest_id = 'q1' AND message_id = 'message-3'"
      ).get().parent_message_id;
    } finally {
      raw.close();
    }
    assert.equal(String(storedParent), rootId);

    // The flattened link survives a reopen (it is a real column, not a view trick).
    const reopenedInner = new SQLiteControlStore({ path });
    const reopened = withReplyPolicy(reopenedInner);
    try {
      const view = await reopened.getCollaboration("p1", "q1");
      assert.equal(threadOf(view, threadId).messages[2].replyToMessageId, rootId);
    } finally {
      reopenedInner.close();
    }
  } finally {
    await dispose(dir, inner);
  }
});

test("FIN-12 reply policy: a legacy nested chain is flattened on the next reply", async () => {
  const { dir, inner, store } = await makeStore("living-history-fin12-replies-legacy-");
  try {
    const opened = await store.createThread("p1", "q1", {
      anchor: { kind: "board", targetId: null, position: { x: 4, y: 4 } },
      text: "Корень", idempotencyKey: "legacy-thread", actorUserId: "author-1"
    });
    const threadId = opened.view.threads[0].threadId;
    const rootId = opened.view.threads[0].messages[0].messageId;

    // Build a nested chain against the raw store (bypassing the policy), the way
    // rows written while the parent link was optional look today.
    const raw = inner;
    await raw.addMessage("p1", "q1", { threadId, text: "Legacy reply", replyToMessageId: rootId, idempotencyKey: "legacy-1", actorUserId: "author-2" });
    const chain = await store.getCollaboration("p1", "q1");
    const legacyReplyId = threadOf(chain, threadId).messages[1].messageId;
    await raw.addMessage("p1", "q1", { threadId, text: "Legacy nested", replyToMessageId: legacyReplyId, idempotencyKey: "legacy-2", actorUserId: "author-3" });
    const nestedId = threadOf(await store.getCollaboration("p1", "q1"), threadId).messages[2].messageId;
    assert.equal(threadOf(await store.getCollaboration("p1", "q1"), threadId).messages[2].replyToMessageId, legacyReplyId);

    // The policy wrapper flattens the legacy chain to the true root.
    const flattened = await store.addMessage("p1", "q1", {
      threadId, text: "Ответ на legacy-цепь", replyToMessageId: nestedId, expectedRevision: 3,
      idempotencyKey: "legacy-flatten", actorUserId: "author-4"
    });
    assert.equal(flattened.kind, "updated");
    assert.equal(threadOf(flattened.view, threadId).messages[3].replyToMessageId, rootId);
  } finally {
    await dispose(dir, inner);
  }
});

test("FIN-12 reply policy: the wrapper leaves notes, edits and the status no-op untouched", async () => {
  const { dir, inner, store } = await makeStore("living-history-fin12-replies-passthrough-");
  try {
    const note = await store.createNote("p1", "q1", {
      text: "Заметка", position: { x: 1, y: 1 }, idempotencyKey: "pass-note", actorUserId: "author-1"
    });
    assert.equal(note.kind, "created");

    const opened = await store.createThread("p1", "q1", {
      anchor: { kind: "board", targetId: null, position: { x: 5, y: 5 } },
      text: "Тред", idempotencyKey: "pass-thread", actorUserId: "author-1"
    });
    const threadId = opened.view.threads[0].threadId;

    const resolved = await store.setThreadStatus("p1", "q1", {
      threadId, expectedRevision: 1, status: "resolved", idempotencyKey: "pass-resolve", actorUserId: "author-1"
    });
    assert.equal(resolved.kind, "updated");

    // Repeating the same status is still a true no-op through the wrapper.
    const beforeNoop = resolved.view.revision;
    const again = await store.setThreadStatus("p1", "q1", {
      threadId, expectedRevision: 2, status: "resolved", idempotencyKey: "pass-resolve-again", actorUserId: "author-1"
    });
    assert.equal(again.kind, "updated");
    assert.equal(threadOf(again.view, threadId).revision, 2);
    assert.equal(again.view.revision, beforeNoop, "a repeated status must not bump the collection revision");

    const replay = await store.setThreadStatus("p1", "q1", {
      threadId, expectedRevision: 2, status: "resolved", idempotencyKey: "pass-resolve-again", actorUserId: "author-1"
    });
    assert.equal(replay.kind, "replay");
  } finally {
    await dispose(dir, inner);
  }
});
