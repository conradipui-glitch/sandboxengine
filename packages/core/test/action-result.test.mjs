import test from "node:test";
import assert from "node:assert/strict";
import { executedResult, isCanonicalActionResult } from "../dist/index.js";

test("Core creates a minimal executed result", () => {
  const result = executedResult(12, [{ type: "resource.change", sourceId: "action.demo" }]);
  assert.deepEqual(result, {
    status: "executed",
    durationSeconds: 12,
    effects: [{ type: "resource.change", sourceId: "action.demo" }]
  });
  assert.equal(isCanonicalActionResult(result), true);
});

test("Core rejects malformed or processing-only results", () => {
  assert.equal(isCanonicalActionResult({ status: "failed", durationSeconds: 0, effects: [] }), false);
  assert.equal(isCanonicalActionResult({ status: "executed", durationSeconds: -1, effects: [] }), false);
  assert.equal(isCanonicalActionResult({ status: "executed", durationSeconds: 1.5, effects: [] }), false);
  assert.equal(isCanonicalActionResult({ status: "executed", durationSeconds: 0, effects: [{ type: "x" }] }), false);
  assert.throws(() => executedResult(-1), RangeError);
});

