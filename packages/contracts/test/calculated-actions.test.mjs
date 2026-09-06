import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import {
  CALCULATED_ACTION_TYPES,
  CONTRACT_SCHEMA_IDS,
  isCalculatedAction
} from "../dist/index.js";

async function readJson(relative) {
  return JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
}

test("CalculatedAction starts as a strict core.paint outcome union", async () => {
  const gameplaySchema = await readJson("../schemas/v1/gameplay-effect.schema.json");
  const actionSchema = await readJson("../schemas/v1/calculated-action.schema.json");
  assert.equal(actionSchema.$id, CONTRACT_SCHEMA_IDS.calculatedAction);
  assert.deepEqual(CALCULATED_ACTION_TYPES, ["core.paint"]);

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(gameplaySchema);
  const validate = ajv.compile(actionSchema);
  const valid = await readJson("../fixtures/calculated-action.paint.partial.json");
  const invalid = await readJson("../fixtures/calculated-action.paint.invalid.json");

  assert.equal(validate(valid), true);
  assert.equal(isCalculatedAction(valid), true);
  assert.equal(validate(invalid), false);
  assert.equal(isCalculatedAction(invalid), false);
});

test("CalculatedAction rejects unregistered action types and unknown fields", () => {
  const base = {
    schemaVersion: "1.0",
    actionType: "core.wait",
    status: "executed",
    reasonCode: null,
    requestedUnits: 1,
    completedUnits: 1,
    durationSeconds: 1,
    effects: []
  };
  assert.equal(isCalculatedAction(base), false);
  assert.equal(isCalculatedAction({ ...base, actionType: "core.paint", statePatch: {} }), false);
});
