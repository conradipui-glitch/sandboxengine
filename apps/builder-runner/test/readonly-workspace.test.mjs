import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { createBuilderWorkspacePolicy } from "../dist/workspace-policy.js";
import { BuilderWorkspaceError, createReadonlyBuilderWorkspace } from "../dist/readonly-workspace.js";

const execFile = promisify(execFileCallback);

async function git(args, cwd) {
  const { stdout } = await execFile("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}

async function fixtureRepository() {
  const root = await mkdtemp(join(tmpdir(), "builder-workspace-fixture-"));
  const source = join(root, "source");
  await mkdir(source);
  await git(["init", "--initial-branch=main"], source);
  await git(["config", "user.email", "builder-test@example.invalid"], source);
  await git(["config", "user.name", "Builder Test"], source);
  await mkdir(join(source, "allowed"));
  await writeFile(join(source, "allowed", "readme.txt"), "frozen source\n", "utf8");
  await writeFile(join(source, "outside.txt"), "must stay private\n", "utf8");
  await git(["add", "."], source);
  await git(["commit", "--quiet", "-m", "fixture"], source);
  const sha = await git(["rev-parse", "HEAD"], source);
  return { root, source, sha };
}

function policy(source, sha) {
  return createBuilderWorkspacePolicy({
    repositoryId: "owner/project",
    repositoryRoot: source,
    baseBranch: "main",
    baseCommitSha: sha,
    readablePaths: ["allowed"],
    writablePaths: ["allowed"],
    verificationCommands: [{ executable: "npm", args: ["run", "test:builder"] }]
  });
}

test("B13.a1 clones the exact source HEAD and leaves source checkout unchanged", async (t) => {
  const fixture = await fixtureRepository();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const sourceTextBefore = await readFile(join(fixture.source, "allowed", "readme.txt"), "utf8");
  const sourceHeadBefore = await readFile(join(fixture.source, ".git", "HEAD"), "utf8");
  const sourceConfigBefore = await readFile(join(fixture.source, ".git", "config"), "utf8");

  const workspace = await createReadonlyBuilderWorkspace(policy(fixture.source, fixture.sha));
  t.after(() => workspace.dispose());
  assert.notEqual(workspace.workspaceRoot, workspace.sourceRepositoryRoot);
  assert.equal(workspace.baseCommitSha, fixture.sha);
  assert.equal(await workspace.readText("allowed/readme.txt"), sourceTextBefore);
  await assert.rejects(
    workspace.readText("outside.txt"),
    (error) => error instanceof BuilderWorkspaceError && error.code === "workspace_path_invalid"
  );
  assert.equal(await readFile(join(fixture.source, "allowed", "readme.txt"), "utf8"), sourceTextBefore);
  assert.equal(await readFile(join(fixture.source, ".git", "HEAD"), "utf8"), sourceHeadBefore);
  assert.equal(await readFile(join(fixture.source, ".git", "config"), "utf8"), sourceConfigBefore);
  assert.equal(await git(["status", "--porcelain"], fixture.source), "");
});

test("B13.a1 refuses a source repository whose HEAD moved after policy capture", async (t) => {
  const fixture = await fixtureRepository();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(join(fixture.source, "allowed", "next.txt"), "new head\n", "utf8");
  await git(["add", "."], fixture.source);
  await git(["commit", "--quiet", "-m", "head changed"], fixture.source);

  await assert.rejects(
    createReadonlyBuilderWorkspace(policy(fixture.source, fixture.sha)),
    (error) => error instanceof BuilderWorkspaceError && error.code === "base_commit_mismatch"
  );
});

test("B13.a1 rejects a symlink or junction that escapes the isolated checkout", async (t) => {
  const fixture = await fixtureRepository();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const workspace = await createReadonlyBuilderWorkspace(policy(fixture.source, fixture.sha));
  t.after(() => workspace.dispose());
  const outside = join(fixture.root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "not workspace data\n", "utf8");
  const link = join(workspace.workspaceRoot, "allowed", "escape");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    workspace.readText("allowed/escape/secret.txt"),
    (error) => error instanceof BuilderWorkspaceError && error.code === "workspace_path_symlinked"
  );
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "not workspace data\n");
});
