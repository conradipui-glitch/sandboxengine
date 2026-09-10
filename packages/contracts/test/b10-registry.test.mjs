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
const EXPECTED_B10_B = Object.freeze([
  ["control.author.jobs.proposals.task-package", "GET", "/control/v1/projects/{projectId}/quests/{questId}/author/jobs/{jobId}/proposals/{proposalId}/task-packages/{capabilityId}", 200]
]);

test("B10 registry advertises implemented author HTTP, agent-kit read and external task-package export while keeping later authority unavailable", async () => {
  const registry = JSON.parse(await readFile(new URL("../registry/endpoints.json", import.meta.url), "utf8"));
  const byId = new Map(registry.operations.map((operation) => [operation.id, operation]));

  for (const [id, method, path, successStatus] of [...EXPECTED_B10_A, ...EXPECTED_B10_B]) {
    const operation = byId.get(id);
    assert.ok(operation, `missing implemented B10 registry operation ${id}`);
    assert.equal(operation.readiness, "available");
    assert.equal(operation.method, method);
    assert.equal(operation.path, path);
    assert.equal(operation.successStatus, successStatus);
  }

  const available = registry.operations.filter((operation) => operation.readiness === "available");
  assert.equal(available.length, 58);
  assert.equal(
    available.filter((operation) => /^control\.author(?:ing)?\./.test(operation.id)).length,
    EXPECTED_B10_A.length + EXPECTED_B10_B.length
  );
  assert.equal(byId.get("control.capabilities")?.readiness, "planned");
  assert.equal(byId.get("control.agent-kit")?.readiness, "available");
  assert.equal(byId.get("control.agent-kit")?.path, "/control/v1/agent-kit");

  for (const operation of available) {
    assert.doesNotMatch(operation.id, /(?:builder|repository|github|deploy)/i);
    assert.doesNotMatch(operation.path, /(?:builder|repository|github|deploy)/i);
  }

  const generated = await buildGeneratedDocs(root);
  const openapi = JSON.parse(generated.get("docs/agent/api.openapi.json"));
  const capabilities = JSON.parse(generated.get("docs/agent/capabilities.json"));
  const compatibility = JSON.parse(generated.get("docs/agent/compatibility.json"));
  assert.equal(compatibility.availableOperationCount, 58);
  assert.equal(capabilities.operations.length, 58);

  for (const [id, method, path] of [...EXPECTED_B10_A, ...EXPECTED_B10_B]) {
    assert.equal(openapi.paths[path]?.[method.toLowerCase()]?.operationId, id.replace(/[^A-Za-z0-9_]/g, "_"));
    assert.equal(capabilities.operations.some((operation) => operation.id === id), true);
  }
  assert.equal(capabilities.operations.some((operation) => operation.id === "control.capabilities"), false);
  assert.equal(capabilities.operations.some((operation) => operation.id === "control.agent-kit"), true);
  assert.equal(openapi.paths["/control/v1/agent-kit"]?.get?.operationId, "control_agent_kit");
});
