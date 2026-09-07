import test from "node:test";
import assert from "node:assert/strict";
import { buildPluginRegistry } from "@living-history/plugins";
import { buildPluginExecutionRegistry } from "@living-history/plugins/execution";
import { createDeterministicRngState, planTimeAdvance } from "@living-history/core";
import {
  executeRegisteredPluginActionThroughCore,
  processRegisteredPluginSchedulerThroughCore
} from "../dist/plugin-action-service.js";

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

function schedulerRegistry(handle) {
  const plugin = {
    schemaVersion: "1.0",
    pluginId: "dice",
    version: "1.0.0",
    engineApiRange: range,
    description: "scheduler test",
    schemaVersions: [],
    dependencies: [],
    capabilityIds: ["dice.capability.react"],
    recipeIds: [],
    backend: {
      blockTypeIds: [],
      actionTypeIds: [],
      scheduledEventTypeIds: ["dice.event.react"],
      effectTypeIds: []
    },
    ui: null
  };
  const built = buildPluginRegistry([plugin]);
  assert.equal(built.ok, true);
  const executions = buildPluginExecutionRegistry(built.registry, [{
    pluginId: "dice",
    actionResolvers: [],
    schedulerHandlers: [{ eventTypeId: "dice.event.react", handle }]
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

function parentEvent() {
  return {
    schemaVersion: "1.0",
    eventId: "parent-1",
    atElapsedSeconds: 11,
    order: 10,
    sourceId: "runtime.test",
    kind: "core.marker",
    payload: { markerId: "parent" }
  };
}

function timePlan(events, durationSeconds = 5) {
  const result = planTimeAdvance(world(), durationSeconds, events);
  assert.equal(result.ok, true);
  return result;
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

test("B08-02 different seed can change resolver-visible deterministic draw without hidden entropy", () => {
  const executionRegistry = registry((input) => plan(input, { roll: input.rng.drawInt(6) + 1 }));
  const left = execute(executionRegistry, 1);
  const right = execute(executionRegistry, 1000);
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  assert.notEqual(left.plan.reasonCode, right.plan.reasonCode);
  assert.notEqual(left.plan.rngTrace[0].rawUint32, right.plan.rngTrace[0].rawUint32);
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
  const executionRegistry = registry((input) => ({
    ...plan(input),
    statePatch: { resources: [{ id: "energy", value: 999 }] }
  }));
  const result = execute(executionRegistry);
  assert.equal(result.ok, false);
  assert.equal(result.code, "plugin_resolution_failed");
  assert.equal(result.pluginFailure.code, "INVALID_PLAN");
});

test("B08-02 plugin scheduler children are processed by Core dynamic scheduler, not a parallel queue", () => {
  const executionRegistry = schedulerRegistry((input) => {
    const roll = input.rng.drawInt(6) + 1;
    return [{
      schemaVersion: "1.0",
      eventId: "child-1",
      atElapsedSeconds: input.event.atElapsedSeconds + 1,
      order: 5,
      sourceId: input.eventTypeId,
      kind: "core.marker",
      payload: { markerId: `roll-${roll}` }
    }];
  });
  const rngState = createDeterministicRngState(77, "dice.scheduler");
  assert.ok(rngState);
  const result = processRegisteredPluginSchedulerThroughCore({
    registry: executionRegistry,
    state: world(),
    plan: timePlan([parentEvent()]),
    rngState,
    resolveEventTypeId: (event) => event.eventId === "parent-1" ? "dice.event.react" : null
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.processing.appliedEvents.map((event) => event.eventId), ["parent-1", "child-1"]);
  assert.equal(result.processing.state.clock.elapsedSeconds, 15);
  assert.equal(result.processing.state.revision, 1);
  assert.equal(result.rngState.drawIndex, 1);
});

test("B08-02 Core rejects plugin child events generated into the past and RNG is not published on failure", () => {
  const executionRegistry = schedulerRegistry((input) => {
    input.rng.drawInt(6);
    return [{
      schemaVersion: "1.0",
      eventId: "child-past",
      atElapsedSeconds: input.event.atElapsedSeconds - 1,
      order: 10,
      sourceId: input.eventTypeId,
      kind: "core.marker",
      payload: { markerId: "past" }
    }];
  });
  const rngState = createDeterministicRngState(77, "dice.scheduler");
  assert.ok(rngState);
  const result = processRegisteredPluginSchedulerThroughCore({
    registry: executionRegistry,
    state: world(),
    plan: timePlan([parentEvent()]),
    rngState,
    resolveEventTypeId: () => "dice.event.react"
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "scheduler_processing_failed");
  assert.equal(result.coreCode, "generated_event_in_past");
  assert.equal("rngState" in result, false);
  assert.equal(rngState.drawIndex, 0);
});

test("B08-02 Core rejects duplicate plugin child event ids", () => {
  const executionRegistry = schedulerRegistry((input) => [{
    schemaVersion: "1.0",
    eventId: "parent-1",
    atElapsedSeconds: input.event.atElapsedSeconds + 1,
    order: 10,
    sourceId: input.eventTypeId,
    kind: "core.marker",
    payload: { markerId: "duplicate" }
  }]);
  const rngState = createDeterministicRngState(77, "dice.scheduler");
  assert.ok(rngState);
  const result = processRegisteredPluginSchedulerThroughCore({
    registry: executionRegistry,
    state: world(),
    plan: timePlan([parentEvent()]),
    rngState,
    resolveEventTypeId: () => "dice.event.react"
  });
  assert.equal(result.ok, false);
  assert.equal(result.coreCode, "generated_event_duplicate");
});
