import test from "node:test";
import assert from "node:assert/strict";
import { MemoryControlStore } from "../../../packages/control/dist/index.js";
import { routeDraftVersionHttp } from "../dist/draft-version-http.js";

async function route(url, method = "GET") {
  const responses = [];
  let mutationCalls = 0;
  const handled = await routeDraftVersionHttp({
    method,
    url: new URL(url, "http://control.local"),
    store: new MemoryControlStore(),
    requireRole: async () => true,
    requireMutation: async () => { mutationCalls += 1; return true; },
    requireIdempotencyKey: () => "test-key",
    requireJsonObject: async () => ({ sourceRevision: 0, baseRevision: 0 }),
    sendJson: (status, body) => responses.push({ status, body }),
    sendNotFound: () => responses.push({ status: 404, body: { error: { code: "NOT_FOUND" } } })
  });
  return { handled, responses, mutationCalls };
}

test("B09-03 draft version reads reject unknown and duplicate query parameters", async () => {
  const unknownHistory = await route("/control/v1/projects/p1/quests/q1/draft/history?all=1");
  assert.equal(unknownHistory.handled, true);
  assert.equal(unknownHistory.responses[0].status, 400);
  assert.equal(unknownHistory.responses[0].body.error.code, "INVALID_DRAFT_HISTORY_REQUEST");

  const duplicateCompare = await route("/control/v1/projects/p1/quests/q1/draft/compare?baseRevision=0&baseRevision=1&targetRevision=1");
  assert.equal(duplicateCompare.responses[0].status, 400);
  assert.equal(duplicateCompare.responses[0].body.error.code, "INVALID_DRAFT_COMPARE_REQUEST");

  const unknownCompare = await route("/control/v1/projects/p1/quests/q1/draft/compare?baseRevision=0&targetRevision=1&merge=true");
  assert.equal(unknownCompare.responses[0].status, 400);
  assert.equal(unknownCompare.responses[0].body.error.code, "INVALID_DRAFT_COMPARE_REQUEST");

  const duplicateReference = await route("/control/v1/projects/p1/quests/q1/draft/references?revision=0&targetBlockId=a&targetBlockId=b");
  assert.equal(duplicateReference.responses[0].status, 400);
  assert.equal(duplicateReference.responses[0].body.error.code, "INVALID_DRAFT_REFERENCE_REQUEST");
});

test("B09-03 restore rejects query modifiers before CSRF/body mutation path", async () => {
  const result = await route("/control/v1/projects/p1/quests/q1/draft/restore?force=1", "POST");
  assert.equal(result.handled, true);
  assert.equal(result.responses[0].status, 400);
  assert.equal(result.responses[0].body.error.code, "INVALID_DRAFT_RESTORE_REQUEST");
  assert.equal(result.mutationCalls, 0);
});
