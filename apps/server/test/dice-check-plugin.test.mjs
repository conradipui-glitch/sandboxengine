import test from "node:test";
import assert from "node:assert/strict";
import { buildPluginRegistry } from "@living-history/plugins";
import { buildPluginExecutionRegistry } from "@living-history/plugins/execution";
import {
  DICE_CHECK_ACTION_TYPE_ID,
  DICE_CHECK_MANIFEST,
  createDiceCheckRegistration,
  projectDiceCheckResult
} from "@living-history/plugins/dice-check";
import { createDeterministicRngState } from "@living-history/core";
import { executeRegisteredPluginActionThroughCore } from "../dist/plugin-action-service.js";

const authored = Object.freeze({
  schemaVersion: "1.0.0",
  definitionId: "gate-check",
  difficulty: 10,
  modifier: 0,
  durationSeconds: 30,
  onSuccessEffects: Object.freeze([{ type: "resource.change", resourceId: "focus", delta: -1 }]),
  onFailureEffects: Object.freeze([{ type: "resource.change", resourceId: "focus", delta: -2 }]),
  narrative: Object.freeze({
    success: "Успех: {{roll}} против {{difficulty}}.",
    failure: "Неудача: {{roll}} против {{difficulty}}."
  })
});

function world() {
  return {
    schemaVersion: "1.0",
    revision: 0,
    clock: { elapsedSeconds: 100 },
    locations: [{ id: "room" }],
    entities: [],
    resources: [{ id: "focus", unit: "point", value: 5, min: 0, max: 10 }],
    items: [],
    terminal: null
  };
}

function host() {
  const plugins = buildPluginRegistry([DICE_CHECK_MANIFEST]);
  assert.equal(plugins.ok, true);
  const execution = buildPluginExecutionRegistry(plugins.registry, [createDiceCheckRegistration([authored])]);
  assert.equal(execution.ok, true);
  return execution.registry;
}

function execute(seed) {
  const rngState = createDeterministicRngState(seed, DICE_CHECK_ACTION_TYPE_ID);
  assert.ok(rngState);
  return executeRegisteredPluginActionThroughCore({
    registry: host(),
    actionTypeId: DICE_CHECK_ACTION_TYPE_ID,
    state: world(),
    args: { definitionId: "gate-check" },
    rngState
  });
}

test("B08-03 same authored check/state/seed is byte-equivalent through generic host and Core", () => {
  const left = execute(1000);
  const right = execute(1000);
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  assert.deepEqual(left, right);
  assert.equal(left.plan.rngTrace.length, 1);
  assert.equal(left.rngState.drawIndex, 1);
  assert.equal(left.candidateState.clock.elapsedSeconds, 130);
  assert.equal(left.candidateState.revision, 1);
});

test("B08-03 success and failure branches become canonical Core effects without plugin math in Core", () => {
  const success = execute(1000); // deterministic first d20 roll = 13
  assert.equal(success.ok, true);
  const successResult = projectDiceCheckResult(authored, success.plan);
  assert.equal(successResult.outcome, "success");
  assert.equal(successResult.roll, 13);
  assert.equal(success.candidateState.resources[0].value, 4);

  const failure = execute(0); // deterministic first d20 roll = 5
  assert.equal(failure.ok, true);
  const failureResult = projectDiceCheckResult(authored, failure.plan);
  assert.equal(failureResult.outcome, "failure");
  assert.equal(failureResult.roll, 5);
  assert.equal(failure.candidateState.resources[0].value, 3);
});

test("B08-03 authored invalid effect branch still fails atomically at the existing Core invariant gate", () => {
  const invalid = {
    ...authored,
    onSuccessEffects: [{ type: "resource.change", resourceId: "focus", delta: -999 }]
  };
  const plugins = buildPluginRegistry([DICE_CHECK_MANIFEST]);
  assert.equal(plugins.ok, true);
  const execution = buildPluginExecutionRegistry(plugins.registry, [createDiceCheckRegistration([invalid])]);
  assert.equal(execution.ok, true);
  const rngState = createDeterministicRngState(1000, DICE_CHECK_ACTION_TYPE_ID);
  assert.ok(rngState);
  const result = executeRegisteredPluginActionThroughCore({
    registry: execution.registry,
    actionTypeId: DICE_CHECK_ACTION_TYPE_ID,
    state: world(),
    args: { definitionId: "gate-check" },
    rngState
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "effect_application_failed");
  assert.equal(result.effectFailure.code, "resource_out_of_bounds");
  assert.equal(world().resources[0].value, 5);
});
