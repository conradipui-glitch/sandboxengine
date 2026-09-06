import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import {
  CONTRACT_SCHEMA_IDS,
  MAX_EFFECTS_PER_TASK_PHASE,
  SCHEDULED_TASK_KIND,
  SCHEDULED_TERMINAL_EVENT_KIND,
  isScheduledTask,
  isScheduledTerminalEvent,
  isSchedulerEvent
} from "../dist/index.js";

async function readJson(relative) {
  return JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
}

test("ScheduledTask is strict and enforces semantic completion >= start", async () => {
  const gameplay = await readJson("../schemas/v1/gameplay-effect.schema.json");
  const schema = await readJson("../schemas/v1/scheduled-task.schema.json");
  const valid = await readJson("../fixtures/scheduled-task.valid.json");

  assert.equal(schema.$id, CONTRACT_SCHEMA_IDS.scheduledTask);
  assert.equal(SCHEDULED_TASK_KIND, "core.task");
  assert.equal(MAX_EFFECTS_PER_TASK_PHASE, 100);

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(gameplay);
  const validate = ajv.compile(schema);
  assert.equal(validate(valid), true);
  assert.equal(isScheduledTask(valid), true);

  const reversedTime = {
    ...valid,
    startAtElapsedSeconds: 400,
    completeAtElapsedSeconds: 300
  };
  assert.equal(validate(reversedTime), true, "cross-field ordering remains a semantic invariant");
  assert.equal(isScheduledTask(reversedTime), false);
  assert.equal(isScheduledTask({ ...valid, hiddenStatePatch: {} }), false);
});

test("ScheduledTerminalEvent is a separate bounded scheduler event", async () => {
  const schema = await readJson("../schemas/v1/scheduled-terminal-event.schema.json");
  const valid = await readJson("../fixtures/scheduled-terminal-event.valid.json");

  assert.equal(schema.$id, CONTRACT_SCHEMA_IDS.scheduledTerminalEvent);
  assert.equal(SCHEDULED_TERMINAL_EVENT_KIND, "core.terminal");

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  assert.equal(validate(valid), true);
  assert.equal(isScheduledTerminalEvent(valid), true);
  assert.equal(isSchedulerEvent(valid), true);

  assert.equal(isScheduledTerminalEvent({
    ...valid,
    payload: { ...valid.payload, statePatch: { terminal: true } }
  }), false);
  assert.equal(isScheduledTerminalEvent({
    ...valid,
    payload: { reason: "", outcome: "x" }
  }), false);
});
