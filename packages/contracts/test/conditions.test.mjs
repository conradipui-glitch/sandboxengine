import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import {
  CONDITION_TYPES,
  CONTRACT_SCHEMA_IDS,
  CONTRACT_SCHEMA_VERSION,
  isCondition
} from "../dist/index.js";

async function readJson(relative) {
  return JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
}

test("Condition schema exposes only the bounded B02-03 condition language", async () => {
  const schema = await readJson("../schemas/v1/condition.schema.json");
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, CONTRACT_SCHEMA_IDS.condition);
  assert.equal(schema.oneOf[0].properties.schemaVersion.const, CONTRACT_SCHEMA_VERSION);
  assert.deepEqual(CONDITION_TYPES, [
    "resource.atLeast",
    "entity.at",
    "item.heldBy",
    "all",
    "any",
    "not"
  ]);

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  const resource = await readJson("../fixtures/condition.resource-at-least.valid.json");
  const composite = await readJson("../fixtures/condition.composite.valid.json");
  const invalid = await readJson("../fixtures/condition.invalid.json");

  assert.equal(validate(resource), true);
  assert.equal(isCondition(resource), true);
  assert.equal(validate(composite), true);
  assert.equal(isCondition(composite), true);
  assert.equal(validate(invalid), false);
  assert.equal(isCondition(invalid), false);
});

test("Condition rejects unknown fields and empty composites", () => {
  assert.equal(isCondition({
    schemaVersion: "1.0",
    type: "resource.atLeast",
    resourceId: "blue_paint",
    value: 1,
    expression: "eval-me"
  }), false);
  assert.equal(isCondition({ schemaVersion: "1.0", type: "all", conditions: [] }), false);
});
