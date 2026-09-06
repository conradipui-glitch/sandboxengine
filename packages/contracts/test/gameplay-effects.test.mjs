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

test("GameplayEffect is a strict union of implemented executable effect types", async () => {
  const schema = await readJson("../schemas/v1/gameplay-effect.schema.json");
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, CONTRACT_SCHEMA_IDS.gameplayEffect);
  assert.equal(schema.oneOf[0].properties.schemaVersion.const, CONTRACT_SCHEMA_VERSION);
  assert.deepEqual(GAMEPLAY_EFFECT_TYPES, ["resource.change", "item.transfer"]);

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  const resource = await readJson("../fixtures/gameplay-effect.resource-change.valid.json");
  const transfer = await readJson("../fixtures/gameplay-effect.item-transfer.valid.json");
  const invalidTransfer = await readJson("../fixtures/gameplay-effect.item-transfer.invalid.json");

  assert.equal(validate(resource), true);
  assert.equal(isGameplayEffect(resource), true);
  assert.equal(validate(transfer), true);
  assert.equal(isGameplayEffect(transfer), true);
  assert.equal(validate(invalidTransfer), false);
  assert.equal(isGameplayEffect(invalidTransfer), false);

  assert.equal(isEffect(resource), false, "B01 generic Effect v1.0 stays unchanged instead of silently widening");
  assert.equal(isEffect(transfer), false, "new executable variants do not widen the B01 generic envelope");
});

test("unknown gameplay effect types are rejected", () => {
  assert.equal(isGameplayEffect({
    schemaVersion: "1.0",
    type: "item.destroy",
    sourceId: "action.demo",
    itemId: "sealed-box"
  }), false);
});
