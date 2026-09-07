import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function evalEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.LHE_EVAL_API_KEY;
  delete env.LHE_EVAL_MODEL;
  delete env.LHE_EVAL_BASE_URL;
  delete env.LHE_EVAL_OUTPUT;
  return env;
}

test("B06-04 eval:ai is explicit and returns clean not_configured without credentials", () => {
  const run = spawnSync(process.execPath, ["scripts/eval-ai.mjs"], {
    cwd: process.cwd(),
    env: evalEnv(),
    encoding: "utf8",
    timeout: 10_000
  });
  assert.equal(run.status, 0, run.stderr);
  const body = JSON.parse(run.stdout);
  assert.equal(body.status, "not_configured");
  assert.equal(body.model, null);
  assert.deepEqual(body.cases, []);
  assert.match(body.reason, /LHE_EVAL_API_KEY/);
});

test("B06-04 not_configured eval output never echoes unrelated environment secrets", () => {
  const sentinel = "SUPER_SECRET_SENTINEL_4fd31b";
  const run = spawnSync(process.execPath, ["scripts/eval-ai.mjs"], {
    cwd: process.cwd(),
    env: evalEnv({ UNRELATED_SECRET_SENTINEL: sentinel }),
    encoding: "utf8",
    timeout: 10_000
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.includes(sentinel), false);
  assert.equal(run.stderr.includes(sentinel), false);
});
