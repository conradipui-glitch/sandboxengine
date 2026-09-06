import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolvePaintAction } from "../dist/index.js";

async function loadState() {
  return JSON.parse(await readFile(new URL("../../contracts/fixtures/world-state.valid.json", import.meta.url), "utf8"));
}

const definition = {
  id: "action.paint-sky",
  actionType: "core.paint",
  resourceId: "blue_paint",
  resourceUnitsPerUnit: 1,
  durationSecondsPerUnit: 300,
  allowPartial: true
};

function intent(units) {
  return {
    schemaVersion: "1.0",
    actionType: "core.paint",
    participantIds: ["painter"],
    targetIds: [],
    args: { units },
    sourceInput: {
      kind: "action",
      actionType: "core.paint",
      args: { units }
    }
  };
}

test("T01 core: request 8 with paint 2 resolves partial 2, -2 resource and 600 seconds", async () => {
  const state = await loadState();
  const result = resolvePaintAction(state, definition, intent(8));

  assert.equal(result.ok, true);
  assert.deepEqual(result.action, {
    schemaVersion: "1.0",
    actionType: "core.paint",
    status: "partial",
    reasonCode: "RESOURCE_LIMIT",
    requestedUnits: 8,
    completedUnits: 2,
    durationSeconds: 600,
    effects: [{
      schemaVersion: "1.0",
      type: "resource.change",
      sourceId: "action.paint-sky",
      resourceId: "blue_paint",
      delta: -2
    }]
  });
  assert.equal(result.state.resources[0].value, 0);
  assert.equal(result.state.clock.elapsedSeconds, 0, "duration is calculated, not scheduled yet");
  assert.equal(result.state.revision, 7, "resolver does not commit a turn revision");
  assert.equal(state.resources[0].value, 2, "authoritative input remains immutable");
});

test("T01 core repeat with paint 0 is blocked without time or effects", async () => {
  const initial = await loadState();
  const first = resolvePaintAction(initial, definition, intent(8));
  assert.equal(first.ok, true);
  const repeat = resolvePaintAction(first.state, definition, intent(8));

  assert.equal(repeat.ok, true);
  assert.equal(repeat.action.status, "blocked");
  assert.equal(repeat.action.reasonCode, "RESOURCE_LIMIT");
  assert.equal(repeat.action.completedUnits, 0);
  assert.equal(repeat.action.durationSeconds, 0);
  assert.deepEqual(repeat.action.effects, []);
  assert.equal(repeat.state, first.state, "blocked resolution returns the unchanged authoritative state");
  assert.equal(repeat.state.resources[0].value, 0);
});

test("sufficient resource resolves executed", async () => {
  const state = await loadState();
  const result = resolvePaintAction(state, definition, intent(2));

  assert.equal(result.ok, true);
  assert.equal(result.action.status, "executed");
  assert.equal(result.action.reasonCode, null);
  assert.equal(result.action.completedUnits, 2);
  assert.equal(result.action.durationSeconds, 600);
  assert.equal(result.state.resources[0].value, 0);
});

test("partial-disabled action blocks instead of silently shrinking the request", async () => {
  const state = await loadState();
  const result = resolvePaintAction(state, { ...definition, allowPartial: false }, intent(8));

  assert.equal(result.ok, true);
  assert.equal(result.action.status, "blocked");
  assert.equal(result.action.completedUnits, 0);
  assert.deepEqual(result.action.effects, []);
  assert.equal(result.state, state);
  assert.equal(state.resources[0].value, 2);
});

test("invalid intent or definition fails without calculated state", async () => {
  const state = await loadState();
  const invalidIntent = resolvePaintAction(state, definition, intent(0));
  const extraArg = resolvePaintAction(state, definition, { ...intent(1), args: { units: 1, hidden: true } });
  const invalidDefinition = resolvePaintAction(state, { ...definition, resourceUnitsPerUnit: 0 }, intent(1));

  assert.deepEqual(invalidIntent, { ok: false, code: "invalid_intent" });
  assert.deepEqual(extraArg, { ok: false, code: "invalid_intent" });
  assert.deepEqual(invalidDefinition, { ok: false, code: "invalid_definition" });
  assert.equal("state" in invalidIntent, false);
  assert.equal(state.resources[0].value, 2);
});
