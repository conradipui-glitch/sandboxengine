import test from "node:test";
import assert from "node:assert/strict";
import {
  loadAuthorAssistantPanel,
  renderAuthorAssistantPanel
} from "../dist/src/author-assistant.js";

const HASH = "a".repeat(64);
const TURN = "b".repeat(64);

function job(overrides = {}) {
  return Object.freeze({
    jobId: "job-1",
    projectId: "p1",
    questId: "quest",
    ownerUserId: "editor",
    mode: "author",
    state: "waiting_user",
    jobVersion: 7,
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
    activeTimeMsUsed: 15,
    createdAtMs: 1,
    updatedAtMs: 10,
    ...overrides
  });
}

function proposal(overrides = {}) {
  return Object.freeze({
    proposalId: "proposal-1",
    projectId: "p1",
    questId: "quest",
    baseRevision: 0,
    baseContentHash: HASH,
    explanation: "Добавить ресурс и действие",
    changes: Object.freeze([]),
    missingCapabilities: Object.freeze([]),
    origin: Object.freeze({ kind: "assistant", backendId: "scripted-author", jobId: "job-1" }),
    ...overrides
  });
}

function artifact(proposalValue = proposal()) {
  return Object.freeze({
    jobId: "job-1",
    turnKey: TURN,
    artifactHash: "c".repeat(64),
    proposal: proposalValue,
    usage: Object.freeze({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
    createdAtMs: 7
  });
}

function preview(overrides = {}) {
  return Object.freeze({
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
    comparison: Object.freeze({
      projectId: "p1",
      questId: "quest",
      baseRevision: 0,
      targetRevision: 1,
      titleChanged: false,
      entryLocationChanged: false,
      addedBlockIds: Object.freeze(["paint"]),
      removedBlockIds: Object.freeze([]),
      replacedBlockIds: Object.freeze([])
    }),
    ...overrides
  });
}

function read(jobValue = job(), proposalValue = proposal()) {
  return Object.freeze({
    job: jobValue,
    checkpoints: Object.freeze([
      Object.freeze({ jobId: "job-1", ordinal: 0, fact: Object.freeze({ kind: "job.created" }), createdAtMs: 1 }),
      Object.freeze({ jobId: "job-1", ordinal: 1, fact: Object.freeze({ kind: "segment.requested", requestId: "segment-1", requestHash: "d".repeat(64) }), createdAtMs: 2 }),
      Object.freeze({ jobId: "job-1", ordinal: 2, fact: Object.freeze({ kind: "draft.read", blockCount: 3 }), createdAtMs: 3 }),
      Object.freeze({ jobId: "job-1", ordinal: 3, fact: Object.freeze({ kind: "proposal.produced", proposalId: "proposal-1" }), createdAtMs: 4 }),
      Object.freeze({ jobId: "job-1", ordinal: 4, fact: Object.freeze({ kind: "proposal.previewed", proposalId: "proposal-1", stale: false, applyAllowed: true }), createdAtMs: 5 })
    ]),
    messages: Object.freeze([
      Object.freeze({ jobId: "job-1", ordinal: 0, messageId: "m1", role: "author", text: "Добавь краску", proposalId: null, proposalTurnKey: null, payloadHash: "e".repeat(64), createdAtMs: 2 }),
      Object.freeze({ jobId: "job-1", ordinal: 1, messageId: "m2", role: "assistant", text: "Подготовил proposal", proposalId: "proposal-1", proposalTurnKey: TURN, payloadHash: "f".repeat(64), createdAtMs: 6 })
    ]),
    proposalArtifacts: Object.freeze([artifact(proposalValue)])
  });
}

test("B10.a Studio reload discovers latest server job, reads persisted chat and refreshes proposal preview", async () => {
  const calls = [];
  const api = {
    async listAuthorJobs(projectId, questId) {
      calls.push(["list", projectId, questId]);
      return [job(), job({ jobId: "older", updatedAtMs: 1 })];
    },
    async getAuthorJob(projectId, questId, jobId) {
      calls.push(["get", projectId, questId, jobId]);
      return read();
    },
    async previewAuthoringProposal(projectId, questId, proposalValue) {
      calls.push(["preview", projectId, questId, proposalValue.proposalId]);
      return preview();
    }
  };

  const state = await loadAuthorAssistantPanel(api, "p1", "quest");
  assert.equal(state.kind, "ready");
  assert.equal(state.model.job.jobId, "job-1");
  assert.equal(state.model.messages.length, 2);
  assert.equal(state.model.proposalCards.length, 1);
  assert.equal(state.model.proposalCards[0].preview.applyAllowed, true);
  assert.deepEqual(calls, [
    ["list", "p1", "quest"],
    ["get", "p1", "quest", "job-1"],
    ["preview", "p1", "quest", "proposal-1"]
  ]);
});

test("B10.a Studio renderer shows factual checkpoints and fresh Apply without invented progress percentage", async () => {
  const api = {
    async listAuthorJobs() { return [job()]; },
    async getAuthorJob() { return read(); },
    async previewAuthoringProposal() { return preview(); }
  };
  const state = await loadAuthorAssistantPanel(api, "p1", "quest");
  const html = renderAuthorAssistantPanel(state, { canMutate: true, hasMutationProof: true });
  assert.match(html, /mode <strong>author<\/strong>/);
  assert.match(html, /backend <code>scripted-author<\/code>/);
  assert.match(html, /Прочитан authoritative draft: 3 blocks/);
  assert.match(html, /Server preview proposal-1: stale=false, applyAllowed=true/);
  assert.match(html, /data-action="author-apply"/);
  assert.match(html, /data-action="author-stop"/);
  assert.match(html, /data-form="author-message"/);
  assert.doesNotMatch(html, /\b\d+%/);
  assert.doesNotMatch(html, /процент/i);
});

test("B10.a stale or unavailable fresh preview removes Apply fail closed", async () => {
  const staleApi = {
    async listAuthorJobs() { return [job()]; },
    async getAuthorJob() { return read(); },
    async previewAuthoringProposal() { return preview({ stale: true, applyAllowed: false, currentRevision: 2, currentContentHash: "1".repeat(64) }); }
  };
  const staleState = await loadAuthorAssistantPanel(staleApi, "p1", "quest");
  const staleHtml = renderAuthorAssistantPanel(staleState, { canMutate: true, hasMutationProof: true });
  assert.match(staleHtml, /Proposal устарел: current r2/);
  assert.doesNotMatch(staleHtml, /data-action="author-apply"/);

  const brokenApi = {
    async listAuthorJobs() { return [job()]; },
    async getAuthorJob() { return read(); },
    async previewAuthoringProposal() { throw new Error("preview offline"); }
  };
  const brokenState = await loadAuthorAssistantPanel(brokenApi, "p1", "quest");
  const brokenHtml = renderAuthorAssistantPanel(brokenState, { canMutate: true, hasMutationProof: true });
  assert.match(brokenHtml, /Server preview недоступен: preview offline/);
  assert.doesNotMatch(brokenHtml, /data-action="author-apply"/);
});

test("B10.a renderer escapes conversation and missing-capability text", async () => {
  const unsafeProposal = proposal({
    explanation: "<img src=x onerror=alert(1)>",
    missingCapabilities: Object.freeze([{ capabilityId: "unsafe<script>", reason: "<b>not supported</b>" }])
  });
  const baseUnsafeRead = read(job(), unsafeProposal);
  const unsafeRead = Object.freeze({
    ...baseUnsafeRead,
    messages: Object.freeze([
      baseUnsafeRead.messages[0],
      Object.freeze({ ...baseUnsafeRead.messages[1], text: "<script>alert(1)</script>" })
    ])
  });
  const api = {
    async listAuthorJobs() { return [job()]; },
    async getAuthorJob() { return unsafeRead; },
    async previewAuthoringProposal() { return preview({ applyAllowed: false, missingCapabilities: unsafeProposal.missingCapabilities }); }
  };
  const state = await loadAuthorAssistantPanel(api, "p1", "quest");
  const html = renderAuthorAssistantPanel(state, { canMutate: true, hasMutationProof: true });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /unsafe&lt;script&gt;/);
  assert.match(html, /&lt;b&gt;not supported&lt;\/b&gt;/);
});

test("B10.a empty, paused and terminal UI expose only valid controls", async () => {
  assert.match(renderAuthorAssistantPanel({ kind: "empty" }, { canMutate: true, hasMutationProof: true }), /data-action="author-start"/);
  assert.doesNotMatch(renderAuthorAssistantPanel({ kind: "empty" }, { canMutate: true, hasMutationProof: false }), /data-action="author-start"/);

  const pausedRead = read(job({ state: "paused_budget", toolCallsUsed: 12 }));
  const pausedApi = {
    async listAuthorJobs() { return [pausedRead.job]; },
    async getAuthorJob() { return pausedRead; },
    async previewAuthoringProposal() { return preview(); }
  };
  const paused = await loadAuthorAssistantPanel(pausedApi, "p1", "quest");
  const pausedHtml = renderAuthorAssistantPanel(paused, { canMutate: true, hasMutationProof: true });
  assert.match(pausedHtml, /name="resumeBudget" value="true"/);
  assert.match(pausedHtml, /data-action="author-stop"/);

  const cancelledRead = read(job({ state: "cancelled" }));
  const cancelledApi = {
    async listAuthorJobs() { return [cancelledRead.job]; },
    async getAuthorJob() { return cancelledRead; },
    async previewAuthoringProposal() { return preview(); }
  };
  const cancelled = await loadAuthorAssistantPanel(cancelledApi, "p1", "quest");
  const cancelledHtml = renderAuthorAssistantPanel(cancelled, { canMutate: true, hasMutationProof: true });
  assert.doesNotMatch(cancelledHtml, /data-action="author-stop"/);
  assert.doesNotMatch(cancelledHtml, /data-form="author-message"/);
  assert.match(cancelledHtml, /Job завершён/);
});
