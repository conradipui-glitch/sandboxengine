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

  assert.deepEqual(openapi.paths, {});
  assert.deepEqual(capabilities.operations, []);
  assert.deepEqual(capabilities.blockKinds, ["core.character", "core.location", "core.resource"]);
  assert.deepEqual(capabilities.gameplayEffectTypes, ["resource.change"]);
  assert.deepEqual(capabilities.actionTypes, ["core.paint"]);
  assert.equal(generated.get("docs/agent/SKILL.md").includes("resource.change"), true);
  assert.equal(generated.get("docs/agent/SKILL.md").includes("core.paint"), true);
  assert.equal(generated.get("docs/agent/SKILL.md").includes("/v1/sessions"), false);
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
