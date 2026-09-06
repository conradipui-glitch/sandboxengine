import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import {
  CONTRACT_SCHEMA_IDS,
  CONTRACT_SCHEMA_VERSION,
  GAMEPLAY_EFFECT_TYPES,
  isEffect,
  isGameplayEffect
} from "../dist/index.js";

async function readJson(relative) {
  return JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
}

test("GameplayEffect starts as a strict resource.change union without breaking Effect v1.0", async () => {
  const schema = await readJson("../schemas/v1/gameplay-effect.schema.json");
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, CONTRACT_SCHEMA_IDS.gameplayEffect);
  assert.equal(schema.oneOf[0].properties.schemaVersion.const, CONTRACT_SCHEMA_VERSION);
  assert.deepEqual(GAMEPLAY_EFFECT_TYPES, ["resource.change"]);

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  const valid = await readJson("../fixtures/gameplay-effect.resource-change.valid.json");
  const invalid = await readJson("../fixtures/gameplay-effect.resource-change.invalid.json");

  assert.equal(validate(valid), true);
  assert.equal(isGameplayEffect(valid), true);
  assert.equal(validate(invalid), false);
  assert.equal(isGameplayEffect(invalid), false);

  assert.equal(isEffect(valid), false, "B01 generic Effect v1.0 stays unchanged instead of silently widening");
});

test("unknown gameplay effect types are rejected", () => {
  assert.equal(isGameplayEffect({
    schemaVersion: "1.0",
    type: "item.transfer",
    sourceId: "action.demo",
    resourceId: "x",
    delta: 1
  }), false);
});
