import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildGeneratedDocs,
  findStaleGeneratedPaths
} from "../../../scripts/generated-docs.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("generated agent contracts expose only implemented capabilities", async () => {
  const registry = JSON.parse(await readFile(new URL("../registry/endpoints.json", import.meta.url), "utf8"));
  const planned = registry.operations.filter((operation) => operation.readiness === "planned");
  const available = registry.operations.filter((operation) => operation.readiness === "available");
  assert.equal(planned.length > 0, true);

  const generated = await buildGeneratedDocs(root);
  const openapi = JSON.parse(generated.get("docs/agent/api.openapi.json"));
  const capabilities = JSON.parse(generated.get("docs/agent/capabilities.json"));
  const skill = generated.get("docs/agent/SKILL.md");

  assert.deepEqual(
    capabilities.operations.map((operation) => operation.id),
    available.map((operation) => operation.id)
  );

  for (const operation of available) {
    const generatedOperation = openapi.paths[operation.path]?.[operation.method.toLowerCase()];
    assert.ok(generatedOperation, `available operation missing from OpenAPI: ${operation.id}`);
    assert.equal(generatedOperation.operationId, operation.id.replace(/[^A-Za-z0-9_]/g, "_"));
    assert.ok(generatedOperation.responses[String(operation.successStatus ?? 200)]);
    assert.equal(skill.includes(`${operation.method} ${operation.path}`), true);
  }
  for (const operation of planned) {
    assert.equal(openapi.paths[operation.path]?.[operation.method.toLowerCase()] ?? null, null);
    assert.equal(capabilities.operations.some((candidate) => candidate.id === operation.id), false);
    assert.equal(skill.includes(`${operation.method} ${operation.path}`), false);
  }

  assert.deepEqual(capabilities.blockKinds, ["core.action", "core.character", "core.location", "core.resource"]);
  assert.deepEqual(capabilities.gameplayEffectTypes, ["entity.move", "item.transfer", "resource.change"]);
  assert.deepEqual(capabilities.conditionTypes, ["all", "any", "entity.at", "item.heldBy", "not", "resource.atLeast"]);
  assert.deepEqual(capabilities.socialActTypes, ["permission", "request", "response"]);
  assert.deepEqual(capabilities.scheduledEventKinds, ["core.effects", "core.marker", "core.terminal"]);
  assert.deepEqual(capabilities.scheduledTaskKinds, ["core.task"]);
  assert.deepEqual(capabilities.actionTypes, [
    "core.paint",
    "core.social.permission",
    "core.social.request",
    "core.social.response"
  ]);
});

test("generated docs are deterministic and stale content is detected", async () => {
  const first = await buildGeneratedDocs(root);
  const second = await buildGeneratedDocs(root);
  assert.deepEqual([...first.entries()], [...second.entries()]);

  const staleCopy = new Map(first);
  staleCopy.set("docs/agent/capabilities.json", "{}\n");
  assert.deepEqual(findStaleGeneratedPaths(first, staleCopy), ["docs/agent/capabilities.json"]);
  assert.deepEqual(findStaleGeneratedPaths(first, second), []);
});
