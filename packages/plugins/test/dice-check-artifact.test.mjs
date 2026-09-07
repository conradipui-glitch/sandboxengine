import test from "node:test";
import assert from "node:assert/strict";
import { buildPluginRegistry } from "../dist/index.js";
import {
  bindDiceCheckRegistrationToArtifact,
  createDiceCheckAuthoredSidecar,
  isValidDiceCheckAuthoredSidecar
} from "../dist/dice-check-artifact.js";
import {
  DICE_CHECK_ACTION_TYPE_ID,
  DICE_CHECK_MANIFEST
} from "../dist/dice-check.js";
import {
  buildPluginExecutionRegistry,
  resolveRegisteredPluginAction
} from "../dist/backend-execution.js";

function definition(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    definitionId: "frozen-check",
    difficulty: 12,
    modifier: 1,
    durationSeconds: 15,
    onSuccessEffects: [{ type: "resource.change", resourceId: "focus", delta: -1 }],
    onFailureEffects: [{ type: "resource.change", resourceId: "focus", delta: -2 }],
    narrative: { success: "ok {{roll}}", failure: "no {{roll}}" },
    ...overrides
  };
}

function world() {
  return {
    schemaVersion: "1.0", revision: 0, clock: { elapsedSeconds: 0 },
    locations: [{ id: "room" }], entities: [],
    resources: [{ id: "focus", unit: "point", value: 5, min: 0, max: 10 }],
    items: [], terminal: null
  };
}

function rng(value) {
  return {
    drawInt(maxExclusive) {
      return {
        ok: true,
        value,
        provenance: {
          algorithm: "test-v1", seed: 1, streamId: "artifact",
          drawIndex: 0, rawUint32: value, maxExclusive, value
        }
      };
    }
  };
}

test("B08-03 authored dice sidecar is immutable and detached from mutable draft input", () => {
  const hash = "a".repeat(64);
  const draft = definition();
  const sidecar = createDiceCheckAuthoredSidecar(hash, [draft]);
  assert.ok(sidecar);
  assert.equal(Object.isFrozen(sidecar), true);
  assert.equal(Object.isFrozen(sidecar.definitions), true);
  assert.equal(Object.isFrozen(sidecar.definitions[0]), true);
  draft.difficulty = 1;
  draft.onSuccessEffects[0].delta = -9;
  assert.equal(sidecar.definitions[0].difficulty, 12);
  assert.equal(sidecar.definitions[0].onSuccessEffects[0].delta, -1);
  assert.equal(isValidDiceCheckAuthoredSidecar(sidecar), true);
});

test("B08-03 artifact-bound registration fails before execution when frozen hash does not match", () => {
  const sidecar = createDiceCheckAuthoredSidecar("a".repeat(64), [definition()]);
  assert.ok(sidecar);
  assert.deepEqual(bindDiceCheckRegistrationToArtifact(sidecar, "b".repeat(64)), {
    ok: false,
    code: "ARTIFACT_HASH_MISMATCH"
  });
  assert.equal(bindDiceCheckRegistrationToArtifact({ ...sidecar, extra: true }, "a".repeat(64)).code, "INVALID_DICE_CHECK_SIDECAR");
  assert.equal(createDiceCheckAuthoredSidecar("bad", [definition()]), null);
  assert.equal(createDiceCheckAuthoredSidecar("a".repeat(64), [definition(), definition()]), null);
});

test("B08-03 exact frozen artifact binds the executable definition used by the generic execution registry", () => {
  const hash = "c".repeat(64);
  const sidecar = createDiceCheckAuthoredSidecar(hash, [definition()]);
  assert.ok(sidecar);
  const bound = bindDiceCheckRegistrationToArtifact(sidecar, hash);
  assert.equal(bound.ok, true);

  const plugins = buildPluginRegistry([DICE_CHECK_MANIFEST]);
  assert.equal(plugins.ok, true);
  const execution = buildPluginExecutionRegistry(plugins.registry, [bound.registration]);
  assert.equal(execution.ok, true);

  const result = resolveRegisteredPluginAction({
    registry: execution.registry,
    actionTypeId: DICE_CHECK_ACTION_TYPE_ID,
    state: world(),
    args: { definitionId: "frozen-check" },
    rng: rng(10)
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.reasonCode, "DICE_CHECK_SUCCESS");
  assert.equal(result.plan.effects[0].delta, -1);
});
