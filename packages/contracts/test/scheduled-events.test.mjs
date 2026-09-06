import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import {
  CONTRACT_SCHEMA_IDS,
  CONTRACT_SCHEMA_VERSION,
  SCHEDULED_EVENT_KINDS,
  isScheduledEvent
} from "../dist/index.js";

async function readJson(relative) {
  return JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
}

test("ScheduledEvent exposes one bounded marker kind with safe integer time", async () => {
  const schema = await readJson("../schemas/v1/scheduled-event.schema.json");
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, CONTRACT_SCHEMA_IDS.scheduledEvent);
  assert.equal(schema.properties.schemaVersion.const, CONTRACT_SCHEMA_VERSION);
  assert.deepEqual(SCHEDULED_EVENT_KINDS, ["core.marker"]);

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  const valid = await readJson("../fixtures/scheduled-event.marker.valid.json");
  const invalid = await readJson("../fixtures/scheduled-event.invalid.json");

  assert.equal(validate(valid), true);
  assert.equal(isScheduledEvent(valid), true);
  assert.equal(validate(invalid), false);
  assert.equal(isScheduledEvent(invalid), false);
});

test("ScheduledEvent rejects arbitrary payload, executable fields and unsafe integers", () => {
  const base = {
    schemaVersion: "1.0",
    eventId: "event.demo",
    atElapsedSeconds: 10,
    order: 0,
    sourceId: "task.demo",
    kind: "core.marker",
    payload: { markerId: "demo" }
  };

  assert.equal(isScheduledEvent({ ...base, effects: [] }), false);
  assert.equal(isScheduledEvent({ ...base, payload: { markerId: "demo", code: "eval()" } }), false);
  assert.equal(isScheduledEvent({ ...base, atElapsedSeconds: Number.MAX_SAFE_INTEGER + 1 }), false);
  assert.equal(isScheduledEvent({ ...base, order: Number.MAX_SAFE_INTEGER + 1 }), false);
  assert.equal(isScheduledEvent({ ...base, kind: "core.execute" }), false);
});
