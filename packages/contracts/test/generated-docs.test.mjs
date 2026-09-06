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
  assert.equal(registry.operations.some((operation) => operation.readiness === "planned"), true);

  const generated = await buildGeneratedDocs(root);
  const openapi = JSON.parse(generated.get("docs/agent/api.openapi.json"));
  const capabilities = JSON.parse(generated.get("docs/agent/capabilities.json"));

  assert.deepEqual(capabilities.blockKinds, ["core.character", "core.location", "core.resource"]);
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

  assert.deepEqual(
    capabilities.operations.map(({ id, method, path, successStatus }) => ({ id, method, path, successStatus })),
    [
      { id: "runtime.healthz", method: "GET", path: "/healthz", successStatus: 200 },
      { id: "runtime.sessions.create", method: "POST", path: "/v1/sessions", successStatus: 201 },
      { id: "runtime.sessions.get", method: "GET", path: "/v1/sessions/{sessionId}", successStatus: 200 },
      { id: "runtime.sessions.action", method: "POST", path: "/v1/sessions/{sessionId}/actions", successStatus: 200 },
      { id: "runtime.operations.get", method: "GET", path: "/v1/sessions/{sessionId}/operations/{operationId}", successStatus: 200 }
    ]
  );
  assert.equal(capabilities.operations.some((operation) => operation.id === "runtime.quests.list"), false);
  assert.equal(capabilities.operations.some((operation) => operation.id.startsWith("control.")), false);

  assert.equal(openapi.paths["/healthz"].get.responses["200"].description, "Successful response");
  assert.equal(openapi.paths["/v1/sessions"].post.responses["201"].description, "Successful response");
  assert.equal(openapi.paths["/v1/sessions/{sessionId}"].get.responses["200"].description, "Successful response");
  assert.equal(openapi.paths["/v1/sessions/{sessionId}/actions"].post.responses["200"].description, "Successful response");
  assert.equal(openapi.paths["/v1/sessions/{sessionId}/operations/{operationId}"].get.responses["200"].description, "Successful response");
  assert.equal(openapi.paths["/v1/quests"], undefined);
  assert.equal(openapi.paths["/control/v1/capabilities"], undefined);

  const skill = generated.get("docs/agent/SKILL.md");
  assert.equal(skill.includes("POST /v1/sessions"), true);
  assert.equal(skill.includes("/control/v1/capabilities"), false);
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
