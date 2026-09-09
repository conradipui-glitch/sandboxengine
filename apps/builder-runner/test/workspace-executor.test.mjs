import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { createBuilderWorkspacePolicy } from "../dist/workspace-policy.js";
import { MutableWorkspaceError, createMutableBuilderWorkspace, createPolicyVerificationRunner } from "../dist/workspace-executor.js";

const execFile = promisify(execFileCallback);

async function git(args, cwd) {
  const { stdout } = await execFile("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}

async function fixtureRepository() {
  const root = await mkdtemp(join(tmpdir(), "builder-executor-fixture-"));
  const source = join(root, "source");
  await mkdir(source);
  await git(["init", "--initial-branch=main"], source);
  await git(["config", "user.email", "builder-test@example.invalid"], source);
  await git(["config", "user.name", "Builder Test"], source);
  await mkdir(join(source, "allowed"));
  await writeFile(join(source, "allowed", "module.txt"), "version 1\n", "utf8");
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
    verificationCommands: [
      { executable: "git", args: ["status", "--porcelain"] }
    ]
  });
}

test("B13.a2 mutable workspace writes allowed paths and computes deterministic tree identity", async (t) => {
  const fixture = await fixtureRepository();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const first = await createMutableBuilderWorkspace(policy(fixture.source, fixture.sha));
  t.after(() => first.dispose());
  await first.writeText("allowed/module.txt", "version 2\n");
  const firstTree = await first.treeIdentity();
  assert.match(firstTree, /^[0-9a-f]{40}$/);

  const second = await createMutableBuilderWorkspace(policy(fixture.source, fixture.sha));
  t.after(() => second.dispose());
  await second.writeText("allowed/module.txt", "version 2\n");
  const secondTree = await second.treeIdentity();
  assert.equal(firstTree, secondTree);

  // The tree identity must equal what a manual repository with identical full content
  // produces: the identity covers the whole isolated checkout (base files + patches),
  // so the manual fixture replicates every base file with identical bytes.
  const manual = join(fixture.root, "manual");
  await mkdir(join(manual, "allowed"), { recursive: true });
  await git(["init", "--initial-branch=main"], manual);
  await git(["config", "user.email", "builder-test@example.invalid"], manual);
  await git(["config", "user.name", "Builder Test"], manual);
  await writeFile(join(manual, "outside.txt"), "must stay private\n", "utf8");
  await writeFile(join(manual, "allowed", "module.txt"), "version 2\n", "utf8");
  await git(["add", "."], manual);
  const manualTree = await git(["write-tree"], manual);
  assert.equal(firstTree, manualTree);

  // The source checkout must remain untouched.
  assert.equal(await readFile(join(fixture.source, "allowed", "module.txt"), "utf8"), "version 1\n");
  assert.equal(await git(["status", "--porcelain"], fixture.source), "");
});

test("B13.a2 write authorization fails closed outside writable prefixes and for git metadata", async (t) => {
  const fixture = await fixtureRepository();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const workspace = await createMutableBuilderWorkspace(policy(fixture.source, fixture.sha));
  t.after(() => workspace.dispose());

  await assert.rejects(
    workspace.writeText("outside.txt", "nope\n"),
    (error) => error instanceof MutableWorkspaceError && error.code === "write_not_allowed"
  );
  await assert.rejects(
    workspace.writeText("allowed/../../outside.txt", "nope\n"),
    (error) => error instanceof MutableWorkspaceError && error.code === "write_not_allowed"
  );
  await assert.rejects(
    workspace.writeText(".git/config", "nope\n"),
    (error) => error instanceof MutableWorkspaceError && error.code === "write_not_allowed"
  );
  await assert.rejects(
    workspace.writeText("allowed/huge.txt", "x".repeat(1_048_577)),
    (error) => error instanceof MutableWorkspaceError && error.code === "write_failed"
  );
});

test("B13.a2 verification runner executes only policy commands and reports failures", async (t) => {
  const fixture = await fixtureRepository();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const workspace = await createMutableBuilderWorkspace(policy(fixture.source, fixture.sha));
  t.after(() => workspace.dispose());
  const runner = createPolicyVerificationRunner(policy(fixture.source, fixture.sha));

  const outcome = await runner.run(workspace.workspaceRoot, "git", ["status", "--porcelain"]);
  assert.equal(outcome.exitCode, 0);

  await assert.rejects(
    runner.run(workspace.workspaceRoot, "node", ["-e", "process.exit(2)"]),
    (error) => error instanceof MutableWorkspaceError && error.code === "verification_command_unknown"
  );
});
