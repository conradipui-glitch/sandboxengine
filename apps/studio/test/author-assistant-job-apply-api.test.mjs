import test from "node:test";
import assert from "node:assert/strict";
import { ControlApiClient } from "../dist/src/api.js";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("B10.a Studio job-scoped Apply sends no proposal content back from the browser", async () => {
  const requests = [];
  const api = new ControlApiClient(async (input, init) => {
    requests.push({ input: String(input), init });
    if (String(input).endsWith("/auth/login")) return jsonResponse(200, {
      user: { userId: "editor", username: "editor.user" },
      session: { sessionId: "s1", createdAtMs: 1, expiresAtMs: 9999 },
      csrfToken: "csrf-token-for-job-apply-test"
    });
    if (String(input).endsWith("/agent-kit")) return jsonResponse(200, { identity: {
  engineVersion: "0.1.0",
  contractsSchemaVersion: "1.0",
  presentationSchemaVersion: "2.0",
  pluginManifestSchemaVersion: "1.0",
  enginePluginApiVersion: "1.0.0",
  registryVersion: "1.0",
  registryHash: "1".repeat(64),
  pluginRegistryVersion: "1.0",
  pluginRegistryHash: "2".repeat(64),
  apiHash: "3".repeat(64),
  docsHash: "4".repeat(64)
}, files: [] });
    return jsonResponse(201, {
      draft: { projectId: "p1", questId: "quest", draftRevision: 1, title: "Changed", entryLocationId: "start", blocks: [], contentHash: "b".repeat(64) },
      application: { proposalId: "proposal-1", projectId: "p1", questId: "quest", baseRevision: 0, baseContentHash: "a".repeat(64), resultRevision: 1, resultContentHash: "b".repeat(64), origin: { kind: "assistant", backendId: "backend", jobId: "job-1" } }
    });
  });
  await api.login("editor.user", "password");
  await api.applyAuthorJobProposal("p1", "quest", "job-1", "proposal-1", "apply-1");
  assert.equal(requests[1].input, "/control/v1/agent-kit");
  assert.equal(requests[1].init.method, "GET");
  const mutation = requests[2];
  assert.equal(mutation.input, "/control/v1/projects/p1/quests/quest/author/jobs/job-1/proposals/proposal-1/apply");
  assert.equal(mutation.init.method, "POST");
  const headers = new Headers(mutation.init.headers);
  assert.equal(headers.get("x-csrf-token"), "csrf-token-for-job-apply-test");
  assert.equal(headers.get("idempotency-key"), "apply-1");
  assert.equal(headers.get("x-lh-engine-version"), "0.1.0");
  assert.equal(headers.get("x-lh-registry-hash"), "1".repeat(64));
  assert.equal(headers.get("x-lh-docs-hash"), "4".repeat(64));
  assert.deepEqual(JSON.parse(mutation.init.body), {});
});
