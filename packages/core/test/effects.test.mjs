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

function transfer(itemId, destination, sourceId = "action.transfer") {
  return {
    schemaVersion: "1.0",
    type: "item.transfer",
    sourceId,
    itemId,
    destination
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

test("valid item.transfer moves one unique item without mutating authoritative input", async () => {
  const state = await loadState();
  const originalPosition = structuredClone(state.items[0].position);
  const result = tryApplyEffectBatch(state, [
    transfer("sealed-box", { kind: "holder", holderId: "painter" })
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(state.items[0].position, originalPosition, "authoritative item position must not mutate");
  assert.deepEqual(result.state.items[0].position, { kind: "holder", holderId: "painter" });
  assert.equal(Object.keys(result.state.items[0].position).length, 2, "item has exactly one position representation");
  assert.equal(Object.isFrozen(result.state.items), true);
  assert.equal(Object.isFrozen(result.state.items[0].position), true);
});

test("T07 mixed batch is atomic when item transfer fails after resource change", async () => {
  const state = await loadState();
  const originalItem = structuredClone(state.items[0]);
  const result = tryApplyEffectBatch(state, [
    change("blue_paint", -1, "first.consume"),
    transfer("sealed-box", { kind: "holder", holderId: "missing-holder" }, "second.invalid-transfer")
  ]);

  assert.deepEqual(result, {
    ok: false,
    code: "holder_not_found",
    effectIndex: 1,
    effectType: "item.transfer",
    sourceId: "second.invalid-transfer"
  });
  assert.equal("state" in result, false);
  assert.equal(state.resources[0].value, 2, "first effect was never committed");
  assert.deepEqual(state.items[0], originalItem, "item was never partially moved");
});

test("failure in the second resource effect rejects the whole batch without partial state", async () => {
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

test("missing references and unsupported effects fail without state", async () => {
  const state = await loadState();
  const missingResource = tryApplyEffectBatch(state, [change("missing", 1)]);
  const missingItem = tryApplyEffectBatch(state, [transfer("missing-item", { kind: "holder", holderId: "painter" })]);
  const missingLocation = tryApplyEffectBatch(state, [transfer("sealed-box", { kind: "location", locationId: "missing-place" })]);
  const unsupported = tryApplyEffectBatch(state, [{
    schemaVersion: "1.0",
    type: "item.destroy",
    sourceId: "action.test",
    itemId: "sealed-box"
  }]);

  assert.equal(missingResource.ok, false);
  assert.equal(missingResource.code, "resource_not_found");
  assert.equal(missingItem.ok, false);
  assert.equal(missingItem.code, "item_not_found");
  assert.equal(missingLocation.ok, false);
  assert.equal(missingLocation.code, "location_not_found");
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
