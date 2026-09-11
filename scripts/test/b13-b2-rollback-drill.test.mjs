import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeRollbackVerdict, exitCodeForResult } from "../b13-b2-rollback-drill.mjs";

const SCRIPT = fileURLToPath(new URL("../b13-b2-rollback-drill.mjs", import.meta.url));
const worktree = fileURLToPath(new URL("../../", import.meta.url));

const tmp = [];
function makeFixture(payload) {
  const dir = mkdtempSync(join(tmpdir(), "b13-b2-"));
  tmp.push(dir);
  const fixturePath = join(dir, "fixture.json");
  writeFileSync(fixturePath, JSON.stringify(payload));
  return { dir, fixturePath };
}

function runFixture(fixturePath, receiptPath) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: worktree,
    env: { ...process.env, B13_B2_DRILL_FIXTURE: fixturePath, B13_B2_DRILL_RECEIPT_PATH: receiptPath },
    encoding: "utf8"
  });
}

const passPayload = {
  rollbackSmoke: { status: 200, matched: true },
  restoreSmoke: { status: 200, matched: true },
  rollbackReceipt: { runId: 101 },
  restoreReceipt: { runId: 202 }
};

test.after(() => {
  for (const dir of tmp) rmSync(dir, { recursive: true, force: true });
});

test("computeRollbackVerdict: healthy rollback + restore is PASS", () => {
  assert.equal(computeRollbackVerdict(passPayload), "PASS");
});

test("computeRollbackVerdict: broken smoke, wrong status or identical runId is FAIL", () => {
  assert.equal(computeRollbackVerdict({ ...passPayload, rollbackSmoke: { status: 500, matched: true } }), "FAIL");
  assert.equal(computeRollbackVerdict({ ...passPayload, restoreSmoke: { status: 200, matched: false } }), "FAIL");
  assert.equal(computeRollbackVerdict({ ...passPayload, restoreReceipt: { runId: 101 } }), "FAIL");
  assert.equal(computeRollbackVerdict({ rollbackSmoke: null, restoreSmoke: null, rollbackReceipt: null, restoreReceipt: null }), "FAIL");
});

test("exitCodeForResult: PASS -> 0, FAIL -> non-zero", () => {
  assert.equal(exitCodeForResult("PASS"), 0);
  assert.equal(exitCodeForResult("FAIL"), 1);
  assert.notEqual(exitCodeForResult("FAIL"), 0);
});

test("offline drill: FAIL verdict produces a non-zero exit code and writes the receipt", () => {
  const failing = { ...passPayload, rollbackSmoke: { status: 500, matched: false } };
  const { dir, fixturePath } = makeFixture(failing);
  const receiptPath = join(dir, "receipt.json");
  const run = runFixture(fixturePath, receiptPath);
  assert.equal(run.status, 1, `FAIL must exit non-zero, got ${run.status}\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /ROLLBACK DRILL: FAIL/);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.result, "FAIL");
  assert.equal(receipt.mode, "offline-fixture");
});

test("offline drill: PASS verdict exits 0", () => {
  const { dir, fixturePath } = makeFixture(passPayload);
  const receiptPath = join(dir, "receipt.json");
  const run = runFixture(fixturePath, receiptPath);
  assert.equal(run.status, 0, `PASS must exit 0, got ${run.status}\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /ROLLBACK DRILL: PASS/);
});
