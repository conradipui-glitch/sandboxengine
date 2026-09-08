import test from "node:test";
import assert from "node:assert/strict";
import { renderAuthorAssistantPanel } from "../dist/src/author-assistant.js";

const HASH = "a".repeat(64);
const job = Object.freeze({
  jobId: "job-1",
  projectId: "p1",
  questId: "quest",
  ownerUserId: "editor",
  mode: "author",
  state: "waiting_user",
  jobVersion: 3,
  startingDraftRevision: 0,
  startingDraftContentHash: HASH,
  backendId: "scripted-author",
  grant: Object.freeze({
    projectId: "p1",
    questId: "quest",
    allowedOperations: Object.freeze(["draft.read", "proposal.preview", "proposal.apply"]),
    maxToolCalls: 12,
    maxActiveTimeMs: 120000
  }),
  toolCallsUsed: 2,
  activeTimeMsUsed: 10,
  createdAtMs: 1,
  updatedAtMs: 2
});
const proposal = Object.freeze({
  proposalId: "proposal-1",
  projectId: "p1",
  questId: "quest",
  baseRevision: 0,
  baseContentHash: HASH,
  explanation: "Rename quest",
  changes: Object.freeze([{ kind: "quest.title.set", title: "New title" }]),
  missingCapabilities: Object.freeze([]),
  origin: Object.freeze({ kind: "assistant", backendId: "scripted-author", jobId: "job-1" })
});
const artifact = Object.freeze({
  jobId: "job-1",
  turnKey: "b".repeat(64),
  artifactHash: "c".repeat(64),
  proposal,
  usage: Object.freeze({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
  createdAtMs: 2
});
const preview = Object.freeze({
  proposalId: "proposal-1",
  projectId: "p1",
  questId: "quest",
  baseRevision: 0,
  baseContentHash: HASH,
  currentRevision: 0,
  currentContentHash: HASH,
  stale: false,
  applyAllowed: true,
  missingCapabilities: Object.freeze([]),
  candidate: null,
  comparison: null
});

function state(jobValue = job) {
  return Object.freeze({
    kind: "ready",
    model: Object.freeze({
      job: jobValue,
      checkpoints: Object.freeze([]),
      messages: Object.freeze([]),
      proposalCards: Object.freeze([Object.freeze({ artifact, preview, previewError: null })])
    })
  });
}

test("B10.a busy Studio state removes new mutation triggers but keeps Stop available", () => {
  const emptyBusy = renderAuthorAssistantPanel(
    { kind: "empty" },
    { canMutate: true, hasMutationProof: true, busy: true }
  );
  assert.doesNotMatch(emptyBusy, /data-action="author-start"/);

  const busy = renderAuthorAssistantPanel(
    state(),
    { canMutate: true, hasMutationProof: true, busy: true }
  );
  assert.match(busy, /data-action="author-stop"/);
  assert.doesNotMatch(busy, /data-form="author-message"/);
  assert.doesNotMatch(busy, /data-action="author-apply"/);
});

test("B10.a terminal job cannot continue but can start a fresh server conversation", () => {
  const terminalJob = Object.freeze({ ...job, state: "cancelled", jobVersion: 4 });
  const html = renderAuthorAssistantPanel(
    state(terminalJob),
    { canMutate: true, hasMutationProof: true }
  );
  assert.doesNotMatch(html, /data-action="author-stop"/);
  assert.doesNotMatch(html, /data-form="author-message"/);
  assert.doesNotMatch(html, /data-action="author-apply"/);
  assert.match(html, /data-action="author-start"/);
  assert.match(html, /Новый диалог/);
});
