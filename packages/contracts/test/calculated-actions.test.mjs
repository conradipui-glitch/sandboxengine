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

function socialSubject() {
  return { actionType: "core.item.leave-copy", targetIds: ["contract"], args: { until: "morning" } };
}

test("CalculatedAction strict union includes paint and bounded social outcomes", async () => {
  const gameplaySchema = await readJson("../schemas/v1/gameplay-effect.schema.json");
  const socialSchema = await readJson("../schemas/v1/social-act.schema.json");
  const actionSchema = await readJson("../schemas/v1/calculated-action.schema.json");
  assert.equal(actionSchema.$id, CONTRACT_SCHEMA_IDS.calculatedAction);
  assert.deepEqual(CALCULATED_ACTION_TYPES, [
    "core.paint",
    "core.social.request",
    "core.social.permission",
    "core.social.response"
  ]);

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(gameplaySchema);
  ajv.addSchema(socialSchema);
  const validate = ajv.compile(actionSchema);
  const paint = await readJson("../fixtures/calculated-action.paint.partial.json");
  const invalidPaint = await readJson("../fixtures/calculated-action.paint.invalid.json");
  const request = {
    schemaVersion: "1.0",
    actionType: "core.social.request",
    status: "conditional",
    reasonCode: "AWAITING_RESPONSE",
    proposalId: "request.leave-copy",
    fromEntityId: "painter",
    toEntityId: "luca",
    subject: socialSubject(),
    durationSeconds: 0,
    effects: []
  };
  const permission = {
    schemaVersion: "1.0",
    actionType: "core.social.permission",
    status: "executed",
    reasonCode: null,
    permissionId: "permission.relay",
    fromEntityId: "painter",
    toEntityId: "luca",
    subject: { actionType: "core.message.relay", targetIds: ["cardinal"], args: {} },
    durationSeconds: 0,
    effects: []
  };
  const response = {
    schemaVersion: "1.0",
    actionType: "core.social.response",
    status: "executed",
    reasonCode: null,
    responseId: "response.leave-copy.refuse",
    proposalId: "request.leave-copy",
    responderId: "luca",
    decision: "refuse",
    durationSeconds: 0,
    effects: []
  };

  for (const value of [paint, request, permission, response]) {
    assert.equal(validate(value), true);
    assert.equal(isCalculatedAction(value), true);
  }
  assert.equal(validate(invalidPaint), false);
  assert.equal(isCalculatedAction(invalidPaint), false);
});

test("social CalculatedAction cannot pretend a proposal already executed physically", () => {
  const request = {
    schemaVersion: "1.0",
    actionType: "core.social.request",
    status: "conditional",
    reasonCode: "AWAITING_RESPONSE",
    proposalId: "request.leave-copy",
    fromEntityId: "painter",
    toEntityId: "luca",
    subject: socialSubject(),
    durationSeconds: 0,
    effects: []
  };
  assert.equal(isCalculatedAction({ ...request, status: "executed" }), false);
  assert.equal(isCalculatedAction({
    ...request,
    effects: [{ schemaVersion: "1.0", type: "item.transfer", sourceId: "bad", itemId: "contract", destination: { kind: "holder", holderId: "luca" } }]
  }), false);
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
