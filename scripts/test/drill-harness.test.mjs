import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_FIXTURE_ENV,
  FAIL,
  PASS,
  computeVerdict,
  exitCodeForResult,
  isMainModule,
  offlineFixture,
  resolveReceiptPath,
  writeReceipt,
  spawnCollected,
  waitForExit
} from "../lib/drill-harness.mjs";

const worktree = fileURLToPath(new URL("../../", import.meta.url));
const tmp = [];
function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), "drill-harness-"));
  tmp.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tmp) rmSync(dir, { recursive: true, force: true });
});

test("computeVerdict: boolean, array and unknown inputs", () => {
  assert.equal(computeVerdict(true), PASS);
  assert.equal(computeVerdict(false), FAIL);
  assert.equal(computeVerdict([true, true, true]), PASS);
  assert.equal(computeVerdict([true, false]), FAIL);
  assert.equal(computeVerdict([]), FAIL);
  assert.equal(computeVerdict(undefined), FAIL);
  assert.equal(computeVerdict("PASS"), FAIL);
});

test("exitCodeForResult: PASS -> 0, FAIL -> non-zero", () => {
  assert.equal(exitCodeForResult(PASS), 0);
  assert.equal(exitCodeForResult(FAIL), 1);
  assert.notEqual(exitCodeForResult(FAIL), 0);
  // Only PASS exits 0: an unknown verdict must never be silently accepted.
  assert.notEqual(exitCodeForResult("whatever"), 0);
});

test("offlineFixture: reads the configured env var and defaults to undefined", () => {
  assert.equal(offlineFixture({ env: {} }), undefined);
  assert.equal(offlineFixture({ env: { [DEFAULT_FIXTURE_ENV]: "x.json" } }), "x.json");
  assert.equal(offlineFixture({ envVar: "OTHER", env: { OTHER: "y.json" } }), "y.json");
  assert.equal(offlineFixture({ envVar: "OTHER", env: { [DEFAULT_FIXTURE_ENV]: "x.json" } }), undefined);
});

test("writeReceipt: writes JSON and creates parent directories", () => {
  const dir = makeTmp();
  const receiptPath = join(dir, "nested", "receipt.json");
  assert.equal(writeReceipt(null, { a: 1 }), null);
  assert.equal(writeReceipt(receiptPath, { result: FAIL, steps: [] }), receiptPath);
  assert.deepEqual(JSON.parse(readFileSync(receiptPath, "utf8")), { result: FAIL, steps: [] });
});

test("resolveReceiptPath: env override wins, fixture mode writes no receipt by default", () => {
  assert.equal(resolveReceiptPath({ env: {}, defaultPath: "d.json" }), "d.json");
  assert.equal(resolveReceiptPath({ env: {}, defaultPath: "d.json", fixtureMode: true }), null);
  assert.equal(resolveReceiptPath({ env: { B13_B2_DRILL_RECEIPT_PATH: "o.json" }, defaultPath: "d.json", fixtureMode: true }), "o.json");
});

test("isMainModule: matches the running module path only", () => {
  const self = fileURLToPath(import.meta.url);
  assert.equal(isMainModule(import.meta.url, self), true);
  assert.equal(isMainModule(import.meta.url, join(worktree, "scripts", "other.mjs")), false);
  assert.equal(isMainModule(import.meta.url, ""), false);
});

test("waitForExit: reports the child exit code", async () => {
  const spawned = spawnCollected(process.execPath, ["-e", "process.exit(3)"]);
  assert.deepEqual(await waitForExit(spawned.child, 10_000), { code: 3, signal: null });
  const already = spawnCollected(process.execPath, ["-e", ""]);
  await waitForExit(already.child, 10_000);
  assert.deepEqual(await waitForExit(already.child, 10_000), { code: 0, signal: null });
});

// End-to-end guard for the load-bearing contract: reportDrill must surface FAIL as a
// non-zero process exit code. It runs in a subprocess because reportDrill sets
// process.exitCode on the process that calls it.
function runHarnessCli(body) {
  return spawnSync(process.execPath, ["--input-type=module", "--eval", body], {
    cwd: worktree,
    encoding: "utf8"
  });
}

test("reportDrill: FAIL verdict prints the verdict line and exits non-zero", () => {
  const run = runHarnessCli(
    'import { reportDrill, FAIL } from "./scripts/lib/drill-harness.mjs";\n' +
    'reportDrill({ label: "HARNESS DRILL", result: FAIL, evidence: { result: "FAIL" } });\n'
  );
  assert.equal(run.status, 1, `FAIL must exit non-zero, got ${run.status}\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /HARNESS DRILL: FAIL/);
});

test("reportDrill: PASS verdict exits 0 and writes the receipt", () => {
  const dir = makeTmp();
  const receiptPath = join(dir, "receipt.json");
  const run = runHarnessCli(
    'import { reportDrill, PASS } from "./scripts/lib/drill-harness.mjs";\n' +
    `reportDrill({ label: "HARNESS DRILL", result: PASS, evidence: { result: "PASS" }, receiptPath: ${JSON.stringify(receiptPath)} });\n`
  );
  assert.equal(run.status, 0, `PASS must exit 0, got ${run.status}\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /HARNESS DRILL: PASS/);
  assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).result, "PASS");
});

test("reportDrill: explicit SKIP outcome may exit 0 without weakening the FAIL contract", () => {
  const run = runHarnessCli(
    'import { reportDrill, SKIP } from "./scripts/lib/drill-harness.mjs";\n' +
    'reportDrill({ label: "HARNESS DRILL", result: SKIP, exitCode: 0 });\n'
  );
  assert.equal(run.status, 0, `SKIP override must exit 0, got ${run.status}\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /HARNESS DRILL: SKIP/);
});

test("importing the harness has no side effects (exit code and files untouched)", () => {
  const run = runHarnessCli('import "./scripts/lib/drill-harness.mjs";\n');
  assert.equal(run.status, 0, `bare import must exit 0, got ${run.status}\n${run.stdout}\n${run.stderr}`);
  assert.equal(run.stdout.trim(), "");
});

test("fixture helper only reads local JSON (no network path exists)", () => {
  const dir = makeTmp();
  const fixturePath = join(dir, "fixture.json");
  writeFileSync(fixturePath, JSON.stringify({ rollbackSmoke: { status: 200, matched: true } }));
  const run = runHarnessCli(
    'import { loadFixture, offlineFixture } from "./scripts/lib/drill-harness.mjs";\n' +
    `const p = offlineFixture({ env: { B13_B2_DRILL_FIXTURE: ${JSON.stringify(fixturePath)} } });\n` +
    "console.log(JSON.stringify(loadFixture(p)));\n"
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim()), { rollbackSmoke: { status: 200, matched: true } });
});
