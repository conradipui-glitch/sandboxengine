import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import {
  buildPluginRegistry
} from "../dist/index.js";
import {
  createPluginArtifactRequirementsSidecar,
  preflightPluginArtifactRequirements
} from "../dist/artifact-compatibility.js";
import {
  DICE_CHECK_ACTION_TYPE_ID,
  DICE_CHECK_CAPABILITY_ID,
  DICE_CHECK_DEFINITION_SCHEMA_ID,
  DICE_CHECK_DEFINITION_SCHEMA_VERSION,
  DICE_CHECK_FORM_ID,
  DICE_CHECK_MANIFEST,
  DICE_CHECK_PLUGIN_ID,
  DICE_CHECK_RECIPE_ID,
  createDiceCheckRegistration,
  diceCheckPluginRequirements,
  projectDiceCheckResult,
  renderDiceCheckNarrative,
  validateDiceCheckDefinition
} from "../dist/dice-check.js";
import {
  buildPluginExecutionRegistry,
  resolveRegisteredPluginAction
} from "../dist/backend-execution.js";

const schema = JSON.parse(await readFile(new URL("../builtin/dice-check/skill-check-definition.schema.json", import.meta.url), "utf8"));
const form = JSON.parse(await readFile(new URL("../builtin/dice-check/studio-form.json", import.meta.url), "utf8"));
const recipe = await readFile(new URL("../builtin/dice-check/recipe.md", import.meta.url), "utf8");
const installed = JSON.parse(await readFile(new URL("../registry/installed.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);

function definition(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    definitionId: "gate-check",
    difficulty: 12,
    modifier: 2,
    durationSeconds: 30,
    onSuccessEffects: [{ type: "resource.change", resourceId: "focus", delta: -1 }],
    onFailureEffects: [{ type: "resource.change", resourceId: "focus", delta: -2 }],
    narrative: {
      success: "Успех: {{roll}} + {{modifier}} = {{total}} против {{difficulty}}.",
      failure: "Неудача: {{roll}} + {{modifier}} = {{total}} против {{difficulty}}."
    },
    ...overrides
  };
}

function rng(value, seed = 7) {
  return {
    drawInt(maxExclusive) {
      return {
        ok: true,
        value,
        provenance: {
          algorithm: "test-v1",
          seed,
          streamId: "dice-check-test",
          drawIndex: 0,
          rawUint32: seed * 100 + value,
          maxExclusive,
          value
        }
      };
    }
  };
}

function executionRegistry(definitions = [definition()]) {
  const built = buildPluginRegistry(installed.plugins);
  assert.equal(built.ok, true);
  const executions = buildPluginExecutionRegistry(built.registry, [createDiceCheckRegistration(definitions)]);
  assert.equal(executions.ok, true);
  return { pluginRegistry: built.registry, executionRegistry: executions.registry };
}

test("B08-03 manifest/schema/form/recipe identities agree", () => {
  assert.equal(DICE_CHECK_MANIFEST.pluginId, DICE_CHECK_PLUGIN_ID);
  assert.deepEqual(DICE_CHECK_MANIFEST.capabilityIds, [DICE_CHECK_CAPABILITY_ID]);
  assert.deepEqual(DICE_CHECK_MANIFEST.backend.actionTypeIds, [DICE_CHECK_ACTION_TYPE_ID]);
  assert.deepEqual(DICE_CHECK_MANIFEST.recipeIds, [DICE_CHECK_RECIPE_ID]);
  assert.deepEqual(DICE_CHECK_MANIFEST.schemaVersions, [{
    schemaId: DICE_CHECK_DEFINITION_SCHEMA_ID,
    version: DICE_CHECK_DEFINITION_SCHEMA_VERSION
  }]);
  assert.equal(schema.$id, "urn:living-history:plugin:dice-check:schema:skill-check:1.0.0");
  assert.equal(schema.properties.schemaVersion.const, DICE_CHECK_DEFINITION_SCHEMA_VERSION);
  assert.equal(form.formId, DICE_CHECK_FORM_ID);
  assert.equal(form.schemaId, DICE_CHECK_DEFINITION_SCHEMA_ID);
  assert.match(recipe, new RegExp(DICE_CHECK_RECIPE_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(recipe, new RegExp(DICE_CHECK_CAPABILITY_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("B08-03 authored definition passes JSON Schema and runtime validation with aligned Studio bounds", () => {
  const value = definition();
  assert.equal(validateSchema(value), true, JSON.stringify(validateSchema.errors));
  assert.equal(validateDiceCheckDefinition(value), true);
  const byPath = new Map(form.fields.map((field) => [field.path, field]));
  assert.equal(byPath.get("difficulty").minimum, schema.properties.difficulty.minimum);
  assert.equal(byPath.get("difficulty").maximum, schema.properties.difficulty.maximum);
  assert.equal(byPath.get("modifier").minimum, schema.properties.modifier.minimum);
  assert.equal(byPath.get("modifier").maximum, schema.properties.modifier.maximum);
  assert.equal(byPath.get("durationSeconds").maximum, schema.properties.durationSeconds.maximum);
});

test("B08-03 malformed bounds, HTML/unknown placeholders and noncanonical effect templates fail closed", () => {
  const badDifficulty = definition({ difficulty: 99 });
  assert.equal(validateSchema(badDifficulty), false);
  assert.equal(validateDiceCheckDefinition(badDifficulty), false);

  assert.equal(validateDiceCheckDefinition(definition({
    narrative: { success: "<b>{{roll}}</b>", failure: "x" }
  })), false);
  assert.equal(validateDiceCheckDefinition(definition({
    narrative: { success: "{{secret}}", failure: "x" }
  })), false);
  assert.equal(validateDiceCheckDefinition(definition({
    onSuccessEffects: [{ type: "dice-check.effect.patch", statePatch: { focus: 999 } }]
  })), false);
});

test("B08-03 resolver draws exactly one d20 and player args cannot inject authored authority", () => {
  const { executionRegistry: registry } = executionRegistry();
  let draws = 0;
  const backend = {
    drawInt(maxExclusive) {
      draws += 1;
      assert.equal(maxExclusive, 20);
      return rng(9).drawInt(maxExclusive);
    }
  };
  const result = resolveRegisteredPluginAction({
    registry,
    actionTypeId: DICE_CHECK_ACTION_TYPE_ID,
    state: {
      schemaVersion: "1.0", revision: 0, clock: { elapsedSeconds: 0 },
      locations: [{ id: "room" }], entities: [],
      resources: [{ id: "focus", unit: "point", value: 5, min: 0, max: 10 }],
      items: [], terminal: null
    },
    args: { definitionId: "gate-check" },
    rng: backend
  });
  assert.equal(result.ok, true);
  assert.equal(draws, 1);
  assert.equal(result.plan.rngTrace[0].maxExclusive, 20);

  const injected = resolveRegisteredPluginAction({
    registry,
    actionTypeId: DICE_CHECK_ACTION_TYPE_ID,
    state: {
      schemaVersion: "1.0", revision: 0, clock: { elapsedSeconds: 0 },
      locations: [{ id: "room" }], entities: [],
      resources: [{ id: "focus", unit: "point", value: 5, min: 0, max: 10 }],
      items: [], terminal: null
    },
    args: { definitionId: "gate-check", difficulty: 1, modifier: 20, effects: [] },
    rng: rng(9)
  });
  assert.equal(injected.ok, false);
  assert.equal(injected.code, "INVALID_ARGS");
});

test("B08-03 success/failure select only the authored branch and project deterministic text", () => {
  const authored = definition();
  const { executionRegistry: registry } = executionRegistry([authored]);
  const state = {
    schemaVersion: "1.0", revision: 0, clock: { elapsedSeconds: 0 },
    locations: [{ id: "room" }], entities: [],
    resources: [{ id: "focus", unit: "point", value: 5, min: 0, max: 10 }],
    items: [], terminal: null
  };
  const success = resolveRegisteredPluginAction({
    registry, actionTypeId: DICE_CHECK_ACTION_TYPE_ID, state,
    args: { definitionId: "gate-check" }, rng: rng(9)
  });
  assert.equal(success.ok, true);
  assert.equal(success.plan.reasonCode, "DICE_CHECK_SUCCESS");
  assert.equal(success.plan.effects[0].delta, -1);
  assert.deepEqual(projectDiceCheckResult(authored, success.plan), {
    roll: 10, modifier: 2, total: 12, difficulty: 12, outcome: "success",
    narrative: "Успех: 10 + 2 = 12 против 12."
  });

  const failure = resolveRegisteredPluginAction({
    registry, actionTypeId: DICE_CHECK_ACTION_TYPE_ID, state,
    args: { definitionId: "gate-check" }, rng: rng(2)
  });
  assert.equal(failure.ok, true);
  assert.equal(failure.plan.reasonCode, "DICE_CHECK_FAILURE");
  assert.equal(failure.plan.effects[0].delta, -2);
  assert.equal(projectDiceCheckResult(authored, failure.plan).outcome, "failure");
});

test("B08-03 narrative renderer is allowlisted text substitution only", () => {
  assert.equal(renderDiceCheckNarrative(
    "{{roll}}/{{total}}/{{difficulty}}/{{outcome}}",
    { roll: 7, modifier: -1, total: 6, difficulty: 10, outcome: "failure" }
  ), "7/6/10/failure");
  assert.equal(renderDiceCheckNarrative("{{secret}}", {
    roll: 7, modifier: -1, total: 6, difficulty: 10, outcome: "failure"
  }), null);
  assert.equal(renderDiceCheckNarrative("<script>x</script>", {
    roll: 7, modifier: -1, total: 6, difficulty: 10, outcome: "failure"
  }), null);
});

test("B08-03 frozen artifact sidecar passes installed registry and blocks missing/incompatible plugin", () => {
  const { pluginRegistry } = executionRegistry();
  const hash = "a".repeat(64);
  const sidecar = createPluginArtifactRequirementsSidecar(hash, diceCheckPluginRequirements());
  assert.ok(sidecar);
  assert.deepEqual(preflightPluginArtifactRequirements(pluginRegistry, sidecar, hash), { ok: true });
  assert.equal(preflightPluginArtifactRequirements(pluginRegistry, sidecar, "b".repeat(64)).code, "ARTIFACT_HASH_MISMATCH");

  const absent = buildPluginRegistry([]);
  assert.equal(absent.ok, true);
  const missing = preflightPluginArtifactRequirements(absent.registry, sidecar, hash);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "PLUGIN_REQUIREMENTS_UNMET");
  assert.equal(missing.issues[0].code, "MISSING_PLUGIN");

  const wrongManifest = JSON.parse(JSON.stringify(DICE_CHECK_MANIFEST));
  wrongManifest.version = "2.0.0";
  const wrong = buildPluginRegistry([wrongManifest]);
  assert.equal(wrong.ok, true);
  const incompatible = preflightPluginArtifactRequirements(wrong.registry, sidecar, hash);
  assert.equal(incompatible.ok, false);
  assert.equal(incompatible.issues.some((issue) => issue.code === "PLUGIN_VERSION_INCOMPATIBLE"), true);
});
