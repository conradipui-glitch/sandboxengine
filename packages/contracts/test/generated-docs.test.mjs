import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  AGENT_RECIPE_DEFINITIONS,
  AGENT_RECIPE_PATHS,
  buildGeneratedDocs,
  computeGeneratedDocsHash,
  findStaleGeneratedPaths,
  validateAgentRecipeDefinitions
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
  const schemaIndex = JSON.parse(generated.get("docs/agent/schema-index.json"));
  const compatibility = JSON.parse(generated.get("docs/agent/compatibility.json"));
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

  assert.match(compatibility.apiHash, /^[a-f0-9]{64}$/);
  assert.match(compatibility.docsHash, /^[a-f0-9]{64}$/);
  assert.equal(compatibility.docsHash, computeGeneratedDocsHash(generated));
  assert.equal(AGENT_RECIPE_PATHS.length, 5);
  for (const path of AGENT_RECIPE_PATHS) {
    const recipe = generated.get(path);
    assert.equal(typeof recipe, "string");
    assert.match(recipe, /generated documentation\/task material only/);
    assert.match(recipe, /does not itself grant command execution/);
  }
  const changedRecipe = new Map(generated);
  changedRecipe.set(AGENT_RECIPE_PATHS[0], `${changedRecipe.get(AGENT_RECIPE_PATHS[0])}\nchanged\n`);
  assert.notEqual(computeGeneratedDocsHash(changedRecipe), compatibility.docsHash);

  assert.equal(capabilities.contractsSchemaVersion, "1.0");
  assert.equal(capabilities.presentationSchemaVersion, "2.0");
  assert.equal(schemaIndex.contractsSchemaVersion, "1.0");
  assert.equal(schemaIndex.presentationSchemaVersion, "2.0");
  assert.equal(
    schemaIndex.schemas.some((schema) => schema.id === "urn:living-history:schema:scene-frame:1.0" && schema.version === "1.0"),
    true
  );
  assert.equal(
    schemaIndex.schemas.some((schema) => schema.id === "urn:living-history:schema:scene-frame:2.0" && schema.version === "2.0"),
    true
  );

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
  assert.deepEqual(capabilities.presentationCommandTypes, [
    "actor.expression",
    "actor.hide",
    "actor.move",
    "actor.show",
    "audio.play",
    "audio.stop",
    "background.set",
    "dialogue.show",
    "item.show",
    "overlay.close",
    "overlay.open",
    "wait"
  ]);
  for (const command of capabilities.presentationCommandTypes) {
    assert.equal(skill.includes(`\`${command}\``), true, `presentation command missing from generated Skill: ${command}`);
  }
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


test("B10.b.10 checked agent recipes reject missing paths and unsafe verification scripts", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  assert.equal(await validateAgentRecipeDefinitions(root, packageJson), true);

  const missingPath = [{
    ...AGENT_RECIPE_DEFINITIONS[0],
    requiredPaths: ["packages/contracts/schemas/v1/definitely-missing.schema.json"]
  }];
  await assert.rejects(
    validateAgentRecipeDefinitions(root, packageJson, missingPath),
    /Missing agent recipe path/
  );

  const existingButUnsafeScript = [{
    ...AGENT_RECIPE_DEFINITIONS[0],
    verificationScripts: ["build"]
  }];
  await assert.rejects(
    validateAgentRecipeDefinitions(root, packageJson, existingButUnsafeScript),
    /Unsafe agent recipe verification script/
  );

  const commandLines = AGENT_RECIPE_DEFINITIONS.flatMap((recipe) =>
    recipe.verificationScripts.map((script) => `npm run ${script}`)
  );
  for (const command of commandLines) {
    assert.match(command, /^npm run [a-z0-9:-]+$/);
    assert.doesNotMatch(command, /(?:deploy|publish|curl|wget|git|shell|exec)/i);
  }
});
