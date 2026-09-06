import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import {
  CONTRACT_SCHEMA_IDS,
  CONTRACT_SCHEMA_VERSION,
  hasValidPresentationPlanReferences,
  hasValidWorldStateReferences,
  isActionResultEnvelope,
  isEffect
} from "../dist/index.js";

const schemaFiles = {
  effect: "effect.schema.json",
  actionResult: "action-result.schema.json",
  worldState: "world-state.schema.json",
  sceneFrame: "scene-frame.schema.json",
  presentationPlan: "presentation-plan.schema.json"
};

async function readJson(relativeUrl) {
  return JSON.parse(await readFile(new URL(relativeUrl, import.meta.url), "utf8"));
}

async function loadSchemas() {
  const loaded = {};
  for (const [name, file] of Object.entries(schemaFiles)) {
    loaded[name] = await readJson(`../schemas/v1/${file}`);
  }
  return loaded;
}

function createAjv(schemas) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const schema of Object.values(schemas)) ajv.addSchema(schema);
  return ajv;
}

function validate(ajv, schemaId, value) {
  const validator = ajv.getSchema(schemaId);
  assert.ok(validator, `schema not registered: ${schemaId}`);
  return validator(value);
}

test("canonical schemas use Draft 2020-12, stable ids and version 1.0", async () => {
  const schemas = await loadSchemas();
  for (const [name, schema] of Object.entries(schemas)) {
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.$id, CONTRACT_SCHEMA_IDS[name]);
    assert.equal(schema.properties.schemaVersion.const, CONTRACT_SCHEMA_VERSION);
  }
});

test("valid fixtures pass the canonical JSON Schemas", async () => {
  const schemas = await loadSchemas();
  const ajv = createAjv(schemas);
  const cases = [
    [CONTRACT_SCHEMA_IDS.effect, "../fixtures/effect.valid.json"],
    [CONTRACT_SCHEMA_IDS.actionResult, "../fixtures/action-result.executed.json"],
    [CONTRACT_SCHEMA_IDS.worldState, "../fixtures/world-state.valid.json"],
    [CONTRACT_SCHEMA_IDS.sceneFrame, "../fixtures/scene-frame.valid.json"],
    [CONTRACT_SCHEMA_IDS.presentationPlan, "../fixtures/presentation-plan.valid.json"]
  ];

  for (const [schemaId, fixture] of cases) {
    assert.equal(validate(ajv, schemaId, await readJson(fixture)), true, `${fixture} should be valid`);
  }
});

test("bad status, version and field types are rejected by JSON Schema", async () => {
  const schemas = await loadSchemas();
  const ajv = createAjv(schemas);
  const cases = [
    [CONTRACT_SCHEMA_IDS.effect, "../fixtures/effect.invalid-type.json"],
    [CONTRACT_SCHEMA_IDS.actionResult, "../fixtures/action-result.invalid.json"],
    [CONTRACT_SCHEMA_IDS.worldState, "../fixtures/world-state.invalid-version.json"],
    [CONTRACT_SCHEMA_IDS.sceneFrame, "../fixtures/scene-frame.invalid-type.json"],
    [CONTRACT_SCHEMA_IDS.presentationPlan, "../fixtures/presentation-plan.invalid-type.json"]
  ];

  for (const [schemaId, fixture] of cases) {
    assert.equal(validate(ajv, schemaId, await readJson(fixture)), false, `${fixture} should be invalid`);
  }
});

test("unknown fields are rejected instead of silently accepted", async () => {
  const schemas = await loadSchemas();
  const ajv = createAjv(schemas);
  const effect = await readJson("../fixtures/effect.valid.json");
  effect.payload = { amount: 1 };
  assert.equal(validate(ajv, CONTRACT_SCHEMA_IDS.effect, effect), false);
  assert.equal(isEffect(effect), false);
});

test("semantic reference checks reject missing world and dialogue ids", async () => {
  const schemas = await loadSchemas();
  const ajv = createAjv(schemas);
  const validWorld = await readJson("../fixtures/world-state.valid.json");
  const badWorld = await readJson("../fixtures/world-state.invalid-reference.json");
  const frame = await readJson("../fixtures/scene-frame.valid.json");
  const validPlan = await readJson("../fixtures/presentation-plan.valid.json");
  const badPlan = await readJson("../fixtures/presentation-plan.invalid-reference.json");

  assert.equal(validate(ajv, CONTRACT_SCHEMA_IDS.worldState, badWorld), true, "reference fixture must be shape-valid first");
  assert.equal(hasValidWorldStateReferences(validWorld), true);
  assert.equal(hasValidWorldStateReferences(badWorld), false);

  assert.equal(validate(ajv, CONTRACT_SCHEMA_IDS.presentationPlan, badPlan), true, "reference fixture must be shape-valid first");
  assert.equal(hasValidPresentationPlanReferences(frame, validPlan), true);
  assert.equal(hasValidPresentationPlanReferences(frame, badPlan), false);
});

test("public TypeScript guard stays compatible with the ActionResult schema", async () => {
  const schemas = await loadSchemas();
  const ajv = createAjv(schemas);
  const valid = await readJson("../fixtures/action-result.executed.json");
  const invalid = await readJson("../fixtures/action-result.invalid.json");

  assert.equal(isActionResultEnvelope(valid), validate(ajv, CONTRACT_SCHEMA_IDS.actionResult, valid));
  assert.equal(isActionResultEnvelope(invalid), validate(ajv, CONTRACT_SCHEMA_IDS.actionResult, invalid));
});
