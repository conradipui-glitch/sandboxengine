import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import {
  CONTRACT_SCHEMA_IDS,
  MAX_EFFECTS_PER_SCHEDULED_EVENT,
  SCHEDULED_EFFECT_EVENT_KIND,
  isScheduledEffectEvent,
  isSchedulerEvent,
  isScheduledEvent
} from "../dist/index.js";

async function readJson(relative) {
  return JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
}

test("ScheduledEffectEvent is a separate strict v1 contract instead of widening ScheduledEvent v1", async () => {
  const gameplay = await readJson("../schemas/v1/gameplay-effect.schema.json");
  const schema = await readJson("../schemas/v1/scheduled-effect-event.schema.json");
  const marker = await readJson("../fixtures/scheduled-event.marker.valid.json");
  const effects = await readJson("../fixtures/scheduled-effect-event.valid.json");
  const invalid = await readJson("../fixtures/scheduled-effect-event.invalid.json");

  assert.equal(schema.$id, CONTRACT_SCHEMA_IDS.scheduledEffectEvent);
  assert.equal(SCHEDULED_EFFECT_EVENT_KIND, "core.effects");
  assert.equal(MAX_EFFECTS_PER_SCHEDULED_EVENT, 100);

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(gameplay);
  const validate = ajv.compile(schema);

  assert.equal(validate(effects), true);
  assert.equal(isScheduledEffectEvent(effects), true);
  assert.equal(isSchedulerEvent(effects), true);
  assert.equal(isScheduledEvent(effects), false, "published marker-only ScheduledEvent v1 stays strict");

  assert.equal(validate(invalid), false);
  assert.equal(isScheduledEffectEvent(invalid), false);
  assert.equal(isSchedulerEvent(marker), true);
});

test("effect events reject arbitrary mutation fields and invalid gameplay effects", () => {
  const base = {
    schemaVersion: "1.0",
    eventId: "event.demo",
    atElapsedSeconds: 10,
    order: 0,
    sourceId: "task.demo",
    kind: "core.effects",
    payload: {
      effects: [{
        schemaVersion: "1.0",
        type: "resource.change",
        sourceId: "event.demo",
        resourceId: "blue_paint",
        delta: 1
      }]
    }
  };

  assert.equal(isScheduledEffectEvent({ ...base, statePatch: { clock: 99 } }), false);
  assert.equal(isScheduledEffectEvent({ ...base, payload: { effects: [], code: "eval()" } }), false);
  assert.equal(isScheduledEffectEvent({
    ...base,
    payload: { effects: [{ ...base.payload.effects[0], type: "arbitrary.mutation" }] }
  }), false);
});
