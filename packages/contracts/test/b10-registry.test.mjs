import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildGeneratedDocs } from "../../../scripts/generated-docs.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const EXPECTED_B10_A = Object.freeze([
  ["control.authoring.proposals.preview", "POST", "/control/v1/projects/{projectId}/quests/{questId}/draft/proposals/preview", 200],
  ["control.authoring.proposals.apply", "POST", "/control/v1/projects/{projectId}/quests/{questId}/draft/proposals/apply", 201],
  ["control.author.jobs.list", "GET", "/control/v1/projects/{projectId}/quests/{questId}/author/jobs", 200],
  ["control.author.jobs.create", "POST", "/control/v1/projects/{projectId}/quests/{questId}/author/jobs", 201],
  ["control.author.jobs.get", "GET", "/control/v1/projects/{projectId}/quests/{questId}/author/jobs/{jobId}", 200],
  ["control.author.jobs.segments.create", "POST", "/control/v1/projects/{projectId}/quests/{questId}/author/jobs/{jobId}/segments", 200],
  ["control.author.jobs.cancel", "POST", "/control/v1/projects/{projectId}/quests/{questId}/author/jobs/{jobId}/cancel", 200],
  ["control.author.jobs.proposals.apply", "POST", "/control/v1/projects/{projectId}/quests/{questId}/author/jobs/{jobId}/proposals/{proposalId}/apply", 201]
]);

test("B10.a registry advertises exactly the implemented author HTTP surface and keeps B10.b/B13 unavailable", async () => {
  const registry = JSON.parse(await readFile(new URL("../registry/endpoints.json", import.meta.url), "utf8"));
  const byId = new Map(registry.operations.map((operation) => [operation.id, operation]));

  for (const [id, method, path, successStatus] of EXPECTED_B10_A) {
    const operation = byId.get(id);
    assert.ok(operation, `missing B10.a registry operation ${id}`);
    assert.equal(operation.readiness, "available");
    assert.equal(operation.method, method);
    assert.equal(operation.path, path);
    assert.equal(operation.successStatus, successStatus);
  }

  assert.equal(registry.operations.filter((operation) => operation.readiness === "available").length, 40);
  assert.equal(byId.get("control.capabilities")?.readiness, "planned");
  assert.equal(byId.get("control.agent-kit")?.readiness, "planned");

  const available = registry.operations.filter((operation) => operation.readiness === "available");
  for (const operation of available) {
    assert.doesNotMatch(operation.id, /(?:builder|repository|github|deploy)/i);
    assert.doesNotMatch(operation.path, /(?:builder|repository|github|deploy)/i);
  }

  const generated = await buildGeneratedDocs(root);
  const openapi = JSON.parse(generated.get("docs/agent/api.openapi.json"));
  const capabilities = JSON.parse(generated.get("docs/agent/capabilities.json"));
  const compatibility = JSON.parse(generated.get("docs/agent/compatibility.json"));
  assert.equal(compatibility.availableOperationCount, 40);
  assert.equal(capabilities.operations.length, 40);

  for (const [id, method, path] of EXPECTED_B10_A) {
    assert.equal(openapi.paths[path]?.[method.toLowerCase()]?.operationId, id.replace(/[^A-Za-z0-9_]/g, "_"));
    assert.equal(capabilities.operations.some((operation) => operation.id === id), true);
  }
  assert.equal(capabilities.operations.some((operation) => operation.id === "control.capabilities"), false);
  assert.equal(capabilities.operations.some((operation) => operation.id === "control.agent-kit"), false);
});
