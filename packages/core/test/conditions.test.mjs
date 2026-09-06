import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { evaluateCondition } from "../dist/index.js";

async function loadState() {
  return JSON.parse(await readFile(new URL("../../contracts/fixtures/world-state.valid.json", import.meta.url), "utf8"));
}

function condition(type, fields) {
  return { schemaVersion: "1.0", type, ...fields };
}

test("known resource/entity/item conditions deterministically return true or false", async () => {
  const state = await loadState();
  assert.deepEqual(evaluateCondition(state, condition("resource.atLeast", { resourceId: "blue_paint", value: 2 })), {
    ok: true,
    value: true
  });
  assert.deepEqual(evaluateCondition(state, condition("resource.atLeast", { resourceId: "blue_paint", value: 3 })), {
    ok: true,
    value: false
  });
  assert.deepEqual(evaluateCondition(state, condition("entity.at", { entityId: "painter", locationId: "workshop" })), {
    ok: true,
    value: true
  });
  assert.deepEqual(evaluateCondition(state, condition("item.heldBy", { itemId: "sealed-box", holderId: "painter" })), {
    ok: true,
    value: false
  });

  const held = {
    ...state,
    items: [{ ...state.items[0], position: { kind: "holder", holderId: "painter" } }]
  };
  assert.deepEqual(evaluateCondition(held, condition("item.heldBy", { itemId: "sealed-box", holderId: "painter" })), {
    ok: true,
    value: true
  });
});

test("composite conditions evaluate without eval and preserve boolean semantics", async () => {
  const state = await loadState();
  const result = evaluateCondition(state, condition("all", {
    conditions: [
      condition("resource.atLeast", { resourceId: "blue_paint", value: 1 }),
      condition("entity.at", { entityId: "painter", locationId: "workshop" }),
      condition("not", {
        condition: condition("item.heldBy", { itemId: "sealed-box", holderId: "painter" })
      })
    ]
  }));
  assert.deepEqual(result, { ok: true, value: true });
});

test("broken references are failures, not false, even after a false sibling", async () => {
  const state = await loadState();
  const missingResource = evaluateCondition(state, condition("resource.atLeast", { resourceId: "missing", value: 1 }));
  assert.deepEqual(missingResource, {
    ok: false,
    code: "resource_not_found",
    conditionType: "resource.atLeast",
    referenceId: "missing"
  });

  const composite = evaluateCondition(state, condition("all", {
    conditions: [
      condition("resource.atLeast", { resourceId: "blue_paint", value: 99 }),
      condition("item.heldBy", { itemId: "missing-item", holderId: "painter" })
    ]
  }));
  assert.equal(composite.ok, false);
  assert.equal(composite.code, "item_not_found");
  assert.equal(composite.referenceId, "missing-item");
});

test("invalid condition shape is distinct from a valid condition that evaluates false", async () => {
  const state = await loadState();
  const result = evaluateCondition(state, {
    schemaVersion: "1.0",
    type: "resource.atLeast",
    resourceId: "blue_paint",
    value: 1,
    code: "arbitrary-js"
  });
  assert.deepEqual(result, {
    ok: false,
    code: "invalid_condition",
    conditionType: "resource.atLeast",
    referenceId: null
  });
});
