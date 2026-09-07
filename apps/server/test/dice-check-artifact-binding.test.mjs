import test from "node:test";
import assert from "node:assert/strict";
import { buildPluginRegistry } from "@living-history/plugins";
import { buildPluginExecutionRegistry } from "@living-history/plugins/execution";
import {
  bindDiceCheckRegistrationToArtifact,
  createDiceCheckAuthoredSidecar
} from "@living-history/plugins/dice-check-artifact";
import {
  DICE_CHECK_ACTION_TYPE_ID,
  DICE_CHECK_MANIFEST,
  projectDiceCheckResult
} from "@living-history/plugins/dice-check";
import { createDeterministicRngState } from "@living-history/core";
import { executeRegisteredPluginActionThroughCore } from "../dist/plugin-action-service.js";

const ARTIFACT_HASH = "d".repeat(64);
const authored = {
  schemaVersion: "1.0.0",
  definitionId: "artifact-check",
  difficulty: 10,
  modifier: 0,
  durationSeconds: 20,
  onSuccessEffects: [{ type: "resource.change", resourceId: "focus", delta: -1 }],
  onFailureEffects: [{ type: "resource.change", resourceId: "focus", delta: -2 }],
  narrative: {
    success: "Успех {{roll}}/{{difficulty}}",
    failure: "Неудача {{roll}}/{{difficulty}}"
  }
};

function world() {
  return {
    schemaVersion: "1.0", revision: 0, clock: { elapsedSeconds: 40 },
    locations: [{ id: "room" }], entities: [],
    resources: [{ id: "focus", unit: "point", value: 5, min: 0, max: 10 }],
    items: [], terminal: null
  };
}

test("B08-03 server proof binds authored dice mechanics to the exact frozen artifact before Core execution", () => {
  const sidecar = createDiceCheckAuthoredSidecar(ARTIFACT_HASH, [authored]);
  assert.ok(sidecar);
  const mismatched = bindDiceCheckRegistrationToArtifact(sidecar, "e".repeat(64));
  assert.deepEqual(mismatched, { ok: false, code: "ARTIFACT_HASH_MISMATCH" });

  const bound = bindDiceCheckRegistrationToArtifact(sidecar, ARTIFACT_HASH);
  assert.equal(bound.ok, true);
  const plugins = buildPluginRegistry([DICE_CHECK_MANIFEST]);
  assert.equal(plugins.ok, true);
  const execution = buildPluginExecutionRegistry(plugins.registry, [bound.registration]);
  assert.equal(execution.ok, true);

  const rngState = createDeterministicRngState(1000, DICE_CHECK_ACTION_TYPE_ID);
  assert.ok(rngState);
  const result = executeRegisteredPluginActionThroughCore({
    registry: execution.registry,
    actionTypeId: DICE_CHECK_ACTION_TYPE_ID,
    state: world(),
    args: { definitionId: "artifact-check" },
    rngState
  });
  assert.equal(result.ok, true);
  assert.equal(result.candidateState.clock.elapsedSeconds, 60);
  assert.equal(result.candidateState.revision, 1);
  const projected = projectDiceCheckResult(sidecar.definitions[0], result.plan);
  assert.ok(projected);
  assert.equal(projected.outcome, "success");
  assert.equal(projected.roll, 13);
  assert.equal(result.candidateState.resources[0].value, 4);
});
