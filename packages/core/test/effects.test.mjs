import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tryApplyEffectBatch } from "../dist/index.js";

async function loadState() {
  return JSON.parse(await readFile(new URL("../../contracts/fixtures/world-state.valid.json", import.meta.url), "utf8"));
}

function change(resourceId, delta, sourceId = "action.test") {
  return {
    schemaVersion: "1.0",
    type: "resource.change",
    sourceId,
    resourceId,
    delta
  };
}

test("resource.change batch applies sequentially to a new state", async () => {
  const state = await loadState();
  const result = tryApplyEffectBatch(state, [
    change("blue_paint", -1, "step.consume"),
    change("blue_paint", 2, "step.refund")
  ]);

  assert.equal(result.ok, true);
  assert.notEqual(result.state, state);
  assert.equal(state.resources[0].value, 2, "authoritative input must not mutate");
  assert.equal(result.state.resources[0].value, 3);
  assert.equal(result.state.revision, state.revision, "effect trial does not commit a turn revision");
  assert.deepEqual(result.appliedEffects.map((effect) => effect.sourceId), ["step.consume", "step.refund"]);
  assert.equal(Object.isFrozen(result.state), true);
  assert.equal(Object.isFrozen(result.state.resources), true);
});

test("failure in the second effect rejects the whole batch without partial state", async () => {
  const state = await loadState();
  const result = tryApplyEffectBatch(state, [
    change("blue_paint", -1, "first.valid"),
    change("blue_paint", -2, "second.breaks-min")
  ]);

  assert.deepEqual(result, {
    ok: false,
    code: "resource_out_of_bounds",
    effectIndex: 1,
    effectType: "resource.change",
    sourceId: "second.breaks-min"
  });
  assert.equal("state" in result, false);
  assert.equal(state.resources[0].value, 2);
});

test("missing resources and unsupported effects fail without state", async () => {
  const state = await loadState();
  const missing = tryApplyEffectBatch(state, [change("missing", 1)]);
  const unsupported = tryApplyEffectBatch(state, [{
    schemaVersion: "1.0",
    type: "item.transfer",
    sourceId: "action.test",
    itemId: "sealed-box"
  }]);

  assert.equal(missing.ok, false);
  assert.equal(missing.code, "resource_not_found");
  assert.equal("state" in missing, false);
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.code, "unsupported_effect");
  assert.equal("state" in unsupported, false);
});

test("unsafe integer deltas are rejected before arithmetic", async () => {
  const state = await loadState();
  const result = tryApplyEffectBatch(state, [change("blue_paint", Number.MAX_SAFE_INTEGER + 1)]);
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_delta");
  assert.equal(state.resources[0].value, 2);
});
