import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryAuthorAgentJobStore,
  MemoryAuthorConversationStore,
  SQLiteAuthorAgentJobStore,
  SQLiteAuthorConversationStore
} from "../dist/index.js";

const HASH = "a".repeat(64);
const TURN = "b".repeat(64);

async function seedJob(jobs, jobId = "job-chat") {
  const created = await jobs.createJob({
    jobId,
    projectId: "p1",
    questId: "quest",
    ownerUserId: "owner",
    startingDraftRevision: 0,
    startingDraftContentHash: HASH,
    backendId: "scripted-author",
    allowedOperations: ["draft.read", "proposal.preview", "proposal.apply"],
    createdAtMs: 1
  });
  assert.equal(created.kind, "created");
}

async function sharedContract(jobs, conversation) {
  await seedJob(jobs);
  const author = await conversation.appendMessage("job-chat", {
    messageId: "msg-author-1",
    role: "author",
    text: "Добавь сцену в мастерской",
    proposalId: null,
    proposalTurnKey: null,
    createdAtMs: 10
  });
  assert.equal(author.kind, "appended");
  assert.equal(author.message.ordinal, 0);

  const assistant = await conversation.appendMessage("job-chat", {
    messageId: "msg-assistant-1",
    role: "assistant",
    text: "Подготовил изменение для проверки.",
    proposalId: "proposal-1",
    proposalTurnKey: TURN,
    createdAtMs: 11
  });
  assert.equal(assistant.kind, "appended");
  assert.equal(assistant.message.ordinal, 1);

  const replay = await conversation.appendMessage("job-chat", {
    messageId: "msg-assistant-1",
    role: "assistant",
    text: "Подготовил изменение для проверки.",
    proposalId: "proposal-1",
    proposalTurnKey: TURN,
    createdAtMs: 999
  });
  assert.equal(replay.kind, "replay");
  assert.equal(replay.message.ordinal, 1);
  assert.equal(replay.message.createdAtMs, 11);

  const reused = await conversation.appendMessage("job-chat", {
    messageId: "msg-assistant-1",
    role: "assistant",
    text: "Другой ответ",
    proposalId: "proposal-1",
    proposalTurnKey: TURN,
    createdAtMs: 12
  });
  assert.equal(reused.kind, "message_id_reused");

  const invalidAuthorArtifact = await conversation.appendMessage("job-chat", {
    messageId: "msg-author-bad",
    role: "author",
    text: "Нельзя привязать proposal к сообщению автора",
    proposalId: "proposal-1",
    proposalTurnKey: TURN,
    createdAtMs: 13
  });
  assert.equal(invalidAuthorArtifact.kind, "invalid_request");

  const messages = await conversation.listMessages("job-chat");
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((entry) => [entry.ordinal, entry.role, entry.messageId]), [
    [0, "author", "msg-author-1"],
    [1, "assistant", "msg-assistant-1"]
  ]);
  assert.equal(Object.isFrozen(messages), true);
  assert.equal(Object.isFrozen(messages[0]), true);
}

test("B10.a Memory conversation is ordered, idempotent and proposal references are assistant-only", async () => {
  const jobs = new MemoryAuthorAgentJobStore();
  const conversation = new MemoryAuthorConversationStore(jobs);
  await sharedContract(jobs, conversation);
});

test("B10.a SQLite conversation matches Memory semantics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lh-b10-chat-"));
  const path = join(dir, "control.sqlite");
  const jobs = new SQLiteAuthorAgentJobStore({ path });
  const conversation = new SQLiteAuthorConversationStore(jobs, { path });
  try {
    await sharedContract(jobs, conversation);
  } finally {
    conversation.close();
    jobs.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("B10.a SQLite conversation survives reopen with exact ordinals and payload hashes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lh-b10-chat-reopen-"));
  const path = join(dir, "control.sqlite");
  let jobs = new SQLiteAuthorAgentJobStore({ path });
  let conversation = new SQLiteAuthorConversationStore(jobs, { path });
  try {
    await seedJob(jobs, "job-reopen");
    const saved = await conversation.appendMessage("job-reopen", {
      messageId: "msg-1",
      role: "author",
      text: "Сохрани это сообщение",
      proposalId: null,
      proposalTurnKey: null,
      createdAtMs: 20
    });
    assert.equal(saved.kind, "appended");
    const expectedHash = saved.message.payloadHash;
    conversation.close();
    jobs.close();

    jobs = new SQLiteAuthorAgentJobStore({ path });
    conversation = new SQLiteAuthorConversationStore(jobs, { path });
    const restored = await conversation.listMessages("job-reopen");
    assert.equal(restored.length, 1);
    assert.equal(restored[0].ordinal, 0);
    assert.equal(restored[0].text, "Сохрани это сообщение");
    assert.equal(restored[0].payloadHash, expectedHash);

    const replay = await conversation.appendMessage("job-reopen", {
      messageId: "msg-1",
      role: "author",
      text: "Сохрани это сообщение",
      proposalId: null,
      proposalTurnKey: null,
      createdAtMs: 999
    });
    assert.equal(replay.kind, "replay");
    assert.equal(replay.message.createdAtMs, 20);
  } finally {
    try { conversation.close(); } catch {}
    try { jobs.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});
