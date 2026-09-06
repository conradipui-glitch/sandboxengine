import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import {
  CONTRACT_SCHEMA_IDS,
  SOCIAL_ACT_TYPES,
  SOCIAL_RESPONSE_DECISIONS,
  isSocialAct
} from "../dist/index.js";

async function readJson(relative) {
  return JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
}

test("SocialAct keeps request, permission and response as strict separate variants", async () => {
  const schema = await readJson("../schemas/v1/social-act.schema.json");
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, CONTRACT_SCHEMA_IDS.socialAct);
  assert.deepEqual(SOCIAL_ACT_TYPES, ["request", "permission", "response"]);
  assert.deepEqual(SOCIAL_RESPONSE_DECISIONS, ["accept", "refuse"]);

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  const request = await readJson("../fixtures/social-act.request.valid.json");
  const permission = await readJson("../fixtures/social-act.permission.valid.json");
  const response = await readJson("../fixtures/social-act.response.accept.valid.json");

  for (const value of [request, permission, response]) {
    assert.equal(validate(value), true);
    assert.equal(isSocialAct(value), true);
  }
});

test("social subject cannot smuggle duration, effects or state mutation", async () => {
  const request = await readJson("../fixtures/social-act.request.valid.json");
  assert.equal(isSocialAct({
    ...request,
    subject: { ...request.subject, durationSeconds: 120 }
  }), false);
  assert.equal(isSocialAct({
    ...request,
    subject: { ...request.subject, effects: [{ type: "item.transfer" }] }
  }), false);
  assert.equal(isSocialAct({
    ...request,
    statePatch: { items: [] }
  }), false);
});

test("response decisions are bounded and permission cannot masquerade as request", async () => {
  const response = await readJson("../fixtures/social-act.response.accept.valid.json");
  const permission = await readJson("../fixtures/social-act.permission.valid.json");
  assert.equal(isSocialAct({ ...response, decision: "maybe" }), false);
  assert.equal(isSocialAct({ ...permission, type: "request" }), false);
});
