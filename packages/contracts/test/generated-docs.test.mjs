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

  assert.equal(Object.keys(openapi.paths).length, 5);
  assert.deepEqual(capabilities.operations.map((operation) => operation.id), [
    "runtime.healthz",
    "runtime.sessions.create",
    "runtime.sessions.get",
    "runtime.sessions.action",
    "runtime.operations.get"
  ]);
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
  assert.equal(generated.get("docs/agent/SKILL.md").includes("POST /v1/sessions"), true);
  assert.equal(generated.get("docs/agent/SKILL.md").includes("/control/v1/projects"), false);
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
