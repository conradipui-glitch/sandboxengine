import test from "node:test";
import assert from "node:assert/strict";
import { buildPluginRegistry } from "@living-history/plugins";
import { buildPluginExecutionRegistry } from "@living-history/plugins/execution";
import { createDeterministicRngState } from "@living-history/core";
import { executeRegisteredPluginActionThroughCore } from "../dist/plugin-action-service.js";

const range = { minInclusive: "1.0.0", maxExclusive: "2.0.0" };

function world() {
  return {
    schemaVersion: "1.0",
    revision: 0,
    clock: { elapsedSeconds: 10 },
    locations: [{ id: "room" }],
    entities: [{ id: "hero", type: "person", status: "available", locationId: "room" }],
    resources: [{ id: "energy", unit: "point", value: 5, min: 0, max: 10 }],
    items: [],
    terminal: null
  };
}

function registry(resolve) {
  const plugin = {
    schemaVersion: "1.0",
    pluginId: "dice",
    version: "1.0.0",
    engineApiRange: range,
    description: "test",
    schemaVersions: [],
    dependencies: [],
    capabilityIds: ["dice.capability.roll"],
    recipeIds: [],
    backend: {
      blockTypeIds: [],
      actionTypeIds: ["dice.action.roll"],
      scheduledEventTypeIds: [],
      effectTypeIds: []
    },
    ui: null
  };
  const built = buildPluginRegistry([plugin]);
  assert.equal(built.ok, true);
  const executions = buildPluginExecutionRegistry(built.registry, [{
    pluginId: "dice",
    actionResolvers: [{
      actionTypeId: "dice.action.roll",
      validateArgs: (args) => args && typeof args === "object" && args.units === 1,
      resolve
    }],
    schedulerHandlers: []
  }]);
  assert.equal(executions.ok, true);
  return executions.registry;
}

function plan(input, { delta = -1, durationSeconds = 7, roll = null, events = [] } = {}) {
  return {
    schemaVersion: "1.0",
    actionTypeId: input.actionTypeId,
    status: "executed",
    requestedUnits: 1,
    completedUnits: 1,
    durationSeconds,
    reasonCode: roll === null ? null : `ROLL_${roll}`,
    effects: [{
      schemaVersion: "1.0",
      type: "resource.change",
      sourceId: input.actionTypeId,
      resourceId: "energy",
      delta
    }],
    scheduledEvents: events
  };
}

function execute(executionRegistry, seed = 123) {
  const rngState = createDeterministicRngState(seed, "dice.action.roll");
  assert.ok(rngState);
  return executeRegisteredPluginActionThroughCore({
    registry: executionRegistry,
    actionTypeId: "dice.action.roll",
    state: world(),
    args: { units: 1 },
    rngState
  });
}

test("B08-02 same state/args/seed produces identical Core candidate and RNG provenance", () => {
  const executionRegistry = registry((input) => {
    const roll = input.rng.drawInt(6) + 1;
    return plan(input, { roll });
  });
  const left = execute(executionRegistry, 77);
  const right = execute(executionRegistry, 77);
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  assert.deepEqual(left, right);
  assert.equal(left.candidateState.resources[0].value, 4);
  assert.equal(left.candidateState.clock.elapsedSeconds, 17);
  assert.equal(left.candidateState.revision, 1);
  assert.equal(left.plan.rngTrace.length, 1);
  assert.equal(left.rngState.drawIndex, 1);
});

test("B08-02 different seed changes resolver-visible deterministic draw without hidden entropy", () => {
  const executionRegistry = registry((input) => plan(input, { roll: input.rng.drawInt(6) + 1 }));
  const left = execute(executionRegistry, 1);
  const right = execute(executionRegistry, 2);
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  assert.notEqual(left.plan.reasonCode, right.plan.reasonCode);
});

test("B08-02 invalid canonical effect fails atomically at existing Core effect gate", () => {
  const executionRegistry = registry((input) => plan(input, { delta: -999 }));
  const result = execute(executionRegistry);
  assert.equal(result.ok, false);
  assert.equal(result.code, "effect_application_failed");
  assert.equal(result.effectFailure.code, "resource_out_of_bounds");
  assert.equal(world().resources[0].value, 5);
});

test("B08-02 plugin-generated canonical scheduler event is handled by existing time planner", () => {
  const executionRegistry = registry((input) => plan(input, {
    durationSeconds: 7,
    events: [{
      schemaVersion: "1.0",
      eventId: "dice-marker-1",
      atElapsedSeconds: 14,
      order: 10,
      sourceId: input.actionTypeId,
      kind: "core.marker",
      payload: { markerId: "dice-rolled" }
    }]
  }));
  const result = execute(executionRegistry);
  assert.equal(result.ok, true);
  assert.equal(result.candidateState.clock.elapsedSeconds, 17);
  assert.equal(result.candidateState.revision, 1);
});

test("B08-02 plugin cannot smuggle a state patch past plan validation", () => {
  const executionRegistry = registry((input) => ({ ...plan(input), statePatch: { resources: [{ id: "energy", value: 999 }] } }));
  const result = execute(executionRegistry);
  assert.equal(result.ok, false);
  assert.equal(result.code, "plugin_resolution_failed");
  assert.equal(result.pluginFailure.code, "INVALID_PLAN");
});
