import test from "node:test";
import assert from "node:assert/strict";
import { ControlApiClient } from "../dist/src/api.js";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const HASH = "a".repeat(64);
const job = {
  jobId: "job-1", projectId: "p1", questId: "quest", ownerUserId: "editor", mode: "author",
  state: "waiting_user", jobVersion: 1, startingDraftRevision: 0, startingDraftContentHash: HASH,
  backendId: "scripted-author",
  grant: { projectId: "p1", questId: "quest", allowedOperations: ["draft.read", "proposal.preview", "proposal.apply"], maxToolCalls: 12, maxActiveTimeMs: 120000 },
  toolCallsUsed: 2, activeTimeMsUsed: 10, createdAtMs: 1, updatedAtMs: 2
};
const proposal = {
  proposalId: "proposal-1", projectId: "p1", questId: "quest", baseRevision: 0, baseContentHash: HASH,
  explanation: "Change", changes: [], missingCapabilities: [],
  origin: { kind: "assistant", backendId: "scripted-author", jobId: "job-1" }
};
const preview = {
  proposalId: "proposal-1", projectId: "p1", questId: "quest", baseRevision: 0, baseContentHash: HASH,
  currentRevision: 0, currentContentHash: HASH, stale: false, applyAllowed: true,
  missingCapabilities: [], candidate: null, comparison: null
};

test("B10.a Studio author client keeps discovery read-only and sends CSRF/idempotency on mutations", async () => {
  const requests = [];
  const api = new ControlApiClient(async (input, init) => {
    const path = String(input);
    requests.push({ path, init });
    if (path.endsWith("/auth/login")) return jsonResponse(200, {
      user: { userId: "editor", username: "editor.user" },
      session: { sessionId: "session-1", createdAtMs: 1, expiresAtMs: 9999 },
      csrfToken: "csrf-token-for-author-assistant-tests"
    });
    if (path.endsWith("/author/jobs") && init.method === "GET") return jsonResponse(200, { jobs: [job] });
    if (path.endsWith("/author/jobs") && init.method === "POST") return jsonResponse(201, { job });
    if (path.endsWith("/author/jobs/job-1") && init.method === "GET") return jsonResponse(200, {
      job, checkpoints: [], messages: [], proposalArtifacts: []
    });
    if (path.endsWith("/author/jobs/job-1/segments")) return jsonResponse(200, {
      job, proposal, preview, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }
    });
    if (path.endsWith("/author/jobs/job-1/cancel")) return jsonResponse(200, { job: { ...job, state: "cancelled" } });
    if (path.endsWith("/draft/proposals/preview")) return jsonResponse(200, { preview });
    if (path.endsWith("/draft/proposals/apply")) return jsonResponse(201, {
      draft: { projectId: "p1", questId: "quest", draftRevision: 1, title: "Source", entryLocationId: "start", contentHash: "b".repeat(64), blocks: [] },
      application: { proposalId: "proposal-1", projectId: "p1", questId: "quest", baseRevision: 0, baseContentHash: HASH, resultRevision: 1, resultContentHash: "b".repeat(64), origin: proposal.origin }
    });
    throw new Error(`unexpected request ${path}`);
  });

  await api.login("editor.user", "editor password 123");
  await api.listAuthorJobs("p1", "quest");
  await api.createAuthorJob("p1", "quest", {}, "create-1");
  await api.getAuthorJob("p1", "quest", "job-1");
  await api.runAuthorSegment("p1", "quest", "job-1", "Add paint", true, "segment-1");
  await api.cancelAuthorJob("p1", "quest", "job-1", "cancel-1");
  await api.previewAuthoringProposal("p1", "quest", proposal);
  await api.applyAuthoringProposal("p1", "quest", proposal, "apply-1");

  const afterLogin = requests.slice(1);
  assert.deepEqual(afterLogin.map((entry) => [entry.init.method, entry.path]), [
    ["GET", "/control/v1/projects/p1/quests/quest/author/jobs"],
    ["POST", "/control/v1/projects/p1/quests/quest/author/jobs"],
    ["GET", "/control/v1/projects/p1/quests/quest/author/jobs/job-1"],
    ["POST", "/control/v1/projects/p1/quests/quest/author/jobs/job-1/segments"],
    ["POST", "/control/v1/projects/p1/quests/quest/author/jobs/job-1/cancel"],
    ["POST", "/control/v1/projects/p1/quests/quest/draft/proposals/preview"],
    ["POST", "/control/v1/projects/p1/quests/quest/draft/proposals/apply"]
  ]);

  for (const index of [0, 2]) {
    assert.equal(new Headers(afterLogin[index].init.headers).get("x-csrf-token"), null);
    assert.equal(new Headers(afterLogin[index].init.headers).get("idempotency-key"), null);
  }
  for (const [index, key] of [[1, "create-1"], [3, "segment-1"], [4, "cancel-1"], [6, "apply-1"]]) {
    const headers = new Headers(afterLogin[index].init.headers);
    assert.equal(headers.get("x-csrf-token"), "csrf-token-for-author-assistant-tests");
    assert.equal(headers.get("idempotency-key"), key);
  }
  const previewHeaders = new Headers(afterLogin[5].init.headers);
  assert.equal(previewHeaders.get("x-csrf-token"), "csrf-token-for-author-assistant-tests");
  assert.equal(previewHeaders.get("idempotency-key"), null);
  assert.deepEqual(JSON.parse(afterLogin[3].init.body), { instruction: "Add paint", resumeBudget: true });
  assert.deepEqual(JSON.parse(afterLogin[6].init.body), { proposal });
});
