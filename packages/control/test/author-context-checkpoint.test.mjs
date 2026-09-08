import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryAuthorAgentJobStore, SQLiteAuthorAgentJobStore } from "../dist/author-agent-jobs.js";

const DRAFT_HASH = "a".repeat(64);
const CONTEXT_HASH = "b".repeat(64);
const fact = Object.freeze({
  kind: "context.selected",
  draftRevision: 7,
  draftContentHash: DRAFT_HASH,
  contextHash: CONTEXT_HASH,
  selectedBlockIds: Object.freeze(["workshop"]),
  includedBlockIds: Object.freeze(["workshop"])
});

function createInput() {
  return {
    jobId: "job-context", projectId: "p1", questId: "q1", ownerUserId: "owner",
    startingDraftRevision: 7, startingDraftContentHash: DRAFT_HASH, backendId: "scripted-author",
    allowedOperations: ["draft.read", "proposal.preview", "proposal.apply"], createdAtMs: 1000
  };
}

async function appendEvidence(store) {
  assert.equal((await store.createJob(createInput())).kind, "created");
  assert.equal((await store.transitionJob("job-context", { expectedJobVersion: 0, to: "running", atMs: 1001 })).kind, "updated");
  const appended = await store.appendCheckpoint("job-context", 1, fact, 1002);
  assert.equal(appended.kind, "updated");
  const checkpoints = await store.listCheckpoints("job-context");
  assert.deepEqual(checkpoints.at(-1).fact, fact);
}

test("B10.b.9 Memory stores exact bounded context evidence", async () => {
  await appendEvidence(new MemoryAuthorAgentJobStore());
});

test("B10.b.9 SQLite context evidence survives reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "lh-b10-context-evidence-"));
  const path = join(root, "control.sqlite");
  try {
    let store = new SQLiteAuthorAgentJobStore({ path });
    await appendEvidence(store);
    store.close();
    store = new SQLiteAuthorAgentJobStore({ path });
    const checkpoints = await store.listCheckpoints("job-context");
    assert.deepEqual(checkpoints.at(-1).fact, fact);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
