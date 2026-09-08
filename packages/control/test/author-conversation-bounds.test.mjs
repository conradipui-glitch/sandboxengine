import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_AUTHOR_CONVERSATION_TEXT_CHARS,
  MemoryAuthorAgentJobStore,
  MemoryAuthorConversationStore
} from "../dist/index.js";

const HASH = "a".repeat(64);

async function seeded() {
  const jobs = new MemoryAuthorAgentJobStore();
  assert.equal((await jobs.createJob({
    jobId: "job-bounds",
    projectId: "p1",
    questId: "quest",
    ownerUserId: "owner",
    startingDraftRevision: 0,
    startingDraftContentHash: HASH,
    backendId: "scripted-author",
    allowedOperations: ["draft.read", "proposal.preview", "proposal.apply"],
    createdAtMs: 1
  })).kind, "created");
  return { jobs, conversation: new MemoryAuthorConversationStore(jobs) };
}

test("B10.a conversation rejects oversize text and never creates orphan messages", async () => {
  const { conversation } = await seeded();
  const oversize = await conversation.appendMessage("job-bounds", {
    messageId: "oversize",
    role: "author",
    text: "x".repeat(MAX_AUTHOR_CONVERSATION_TEXT_CHARS + 1),
    proposalId: null,
    proposalTurnKey: null,
    createdAtMs: 2
  });
  assert.equal(oversize.kind, "invalid_request");
  assert.deepEqual(await conversation.listMessages("job-bounds"), []);

  const orphan = await conversation.appendMessage("missing-job", {
    messageId: "orphan",
    role: "author",
    text: "must not persist",
    proposalId: null,
    proposalTurnKey: null,
    createdAtMs: 3
  });
  assert.equal(orphan.kind, "job_not_found");
  assert.equal(await conversation.listMessages("missing-job"), null);
});
