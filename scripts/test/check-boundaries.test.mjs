import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../check-boundaries.mjs", import.meta.url));
// Resolve the worktree root from the script location so package roots exist.
const worktree = fileURLToPath(new URL("../../", import.meta.url));

const fixtures = [];
function makeCoreFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "check-boundaries-"));
  fixtures.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

function runCore(coreRoot) {
  const env = { ...process.env };
  if (coreRoot) env.CHECK_BOUNDARIES_ROOTS_JSON = JSON.stringify({ Core: coreRoot });
  else delete env.CHECK_BOUNDARIES_ROOTS_JSON;
  return spawnSync(process.execPath, [SCRIPT], { cwd: worktree, env, encoding: "utf8" });
}

test.after(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

test("repository baseline is green", () => {
  const run = runCore(null);
  assert.equal(run.status, 0, `expected exit 0, got ${run.status}\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /check:boundaries ok/);
});

test("static forbidden import fails the check", () => {
  const dir = makeCoreFixture({ "bad.ts": "import { readFileSync } from \"node:fs\";\nexport const x = readFileSync;\n" });
  const run = runCore(dir);
  assert.equal(run.status, 1, `expected exit 1\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /bad\.ts/);
});

test("dynamic import() of a forbidden builtin fails the check", () => {
  const dir = makeCoreFixture({ "dyn.ts": "export async function load() { return await import(\"node:fs\"); }\n" });
  const run = runCore(dir);
  assert.equal(run.status, 1, `expected exit 1 for dynamic import\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /dyn\.ts.*node:fs/);
});

test("dynamic import() of a forbidden workspace package fails the check", () => {
  const dir = makeCoreFixture({ "dyn-pkg.ts": "export const control = () => import(\"@living-history/control\");\n" });
  const run = runCore(dir);
  assert.equal(run.status, 1, `expected exit 1\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /@living-history\/control/);
});

test("dynamic import() with a template-literal specifier fails the check", () => {
  const dir = makeCoreFixture({ "dyn-tpl.ts": "export const fs = () => import(`node:fs`);\n" });
  const run = runCore(dir);
  assert.equal(run.status, 1, `expected exit 1\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /node:fs/);
});

test("dynamic import() with an unresolvable variable is an explicit error, not a silent skip", () => {
  const dir = makeCoreFixture({ "dyn-var.ts": "const target = \"./whatever.ts\";\nexport const m = () => import(target);\n" });
  const run = runCore(dir);
  assert.equal(run.status, 1, `expected exit 1 for unresolvable dynamic import\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /unresolved dynamic import/);
});

test("nested files under packages/*/src are scanned recursively", () => {
  const dir = makeCoreFixture({
    "ok.ts": "export const ok = 1;\n",
    "nested/deep/evil.ts": "import { readFileSync } from \"node:fs\";\nexport const x = readFileSync;\n"
  });
  const run = runCore(dir);
  assert.equal(run.status, 1, `expected exit 1 for nested violation\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /nested\/deep\/evil\.ts/);
});

test("a directory with zero .ts files is not reported green", () => {
  const dir = makeCoreFixture({ "readme.md": "no typescript here\n" });
  const run = runCore(dir);
  assert.equal(run.status, 1, `expected exit 1 for zero-file scan\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /no \.ts files found/);
});

test("missing source root is an explicit failure", () => {
  const run = runCore(join(tmpdir(), "check-boundaries-does-not-exist-xyz"));
  assert.equal(run.status, 1, `expected exit 1 for missing root\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /not readable/);
});

test("clean fixture passes (baseline sanity, not always-red)", () => {
  const dir = makeCoreFixture({ "clean.ts": "import { join } from \"node:path\";\nexport const x = join(\"a\", \"b\");\n" });
  const run = runCore(dir);
  assert.equal(run.status, 0, `expected exit 0 for clean fixture\n${run.stdout}\n${run.stderr}`);
});
