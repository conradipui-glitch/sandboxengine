import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ACTION_STATUSES,
  PROCESSING_STATUSES,
  isActionResultEnvelope,
  isActionStatus,
  isProcessingStatus
} from "../dist/index.js";

test("domain outcomes and processing outcomes stay separate", () => {
  assert.deepEqual(ACTION_STATUSES, ["executed", "partial", "conditional", "blocked"]);
  assert.deepEqual(PROCESSING_STATUSES, ["needs_clarification", "unsupported", "failed"]);
  assert.equal(isActionStatus("executed"), true);
  assert.equal(isActionStatus("failed"), false);
  assert.equal(isProcessingStatus("failed"), true);
  assert.equal(isProcessingStatus("blocked"), false);
});

test("unknown values are rejected", () => {
  for (const value of [null, 1, {}, "done", "EXECUTED"]) {
    assert.equal(isActionStatus(value), false);
    assert.equal(isProcessingStatus(value), false);
  }
});

test("canonical JSON fixtures are checked at the public contract boundary", async () => {
  const valid = JSON.parse(await readFile(new URL("../fixtures/action-result.executed.json", import.meta.url), "utf8"));
  const invalid = JSON.parse(await readFile(new URL("../fixtures/action-result.invalid.json", import.meta.url), "utf8"));
  assert.equal(isActionResultEnvelope(valid), true);
  assert.equal(isActionResultEnvelope(invalid), false);
});
