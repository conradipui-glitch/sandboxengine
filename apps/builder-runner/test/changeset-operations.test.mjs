import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { createBuilderWorkspacePolicy } from "../dist/workspace-policy.js";
import { BoundedChangeSetApplier, ChangeSetError } from "../dist/changeset-operations.js";

const execFile = promisify(execFileCallback);

async function git(args, cwd, env) {
  const { stdout } = await execFile("git", args, { cwd, env, windowsHide: true });
  return stdout.trim();
}

const cleanEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };

async function fixtureRepository() {
  const root = await mkdtemp(join(tmpdir(), "builder-changeset-fixture-"));
  const source = join(root, "source");
  await mkdir(source);
  await git(["init", "--initial-branch=main"], source, cleanEnv);
  await git(["config", "user.email", "builder-test@example.invalid"], source, cleanEnv);
  await git(["config", "user.name", "Builder Test"], source, cleanEnv);
  await mkdir(join(source, "allowed"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(source, "allowed", "module.txt"), "version 1\n", "utf8");
  await git(["add", "."], source, cleanEnv);
  await git(["commit", "--quiet", "-m", "fixture"], source, cleanEnv);
  const sha = await git(["rev-parse", "HEAD"], source, cleanEnv);
  // A bare remote the applier may push to.
  const remote = join(root, "remote.git");
  await execFile("git", ["clone", "--quiet", "--bare", source, remote], { windowsHide: true });
  return { root, source, remote, sha };
}

function policy(source, sha) {
  return createBuilderWorkspacePolicy({
    repositoryId: "owner/project",
    repositoryRoot: source,
    baseBranch: "main",
    baseCommitSha: sha,
    readablePaths: ["allowed"],
    writablePaths: ["allowed"],
    verificationCommands: [{ executable: "git", args: ["status", "--porcelain"] }]
  });
}

function grant() {
  return {
    repositoryId: "owner/project",
    targetBranch: "main",
    authorName: "Builder Test",
    authorEmail: "builder-test@example.invalid",
    commitSubject: "B13.b1: apply bounded change set"
  };
}

test("B13.b1 applies and pushes a bounded change set and records the exact commit", async (t) => {
  const fixture = await fixtureRepository();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const applier = new BoundedChangeSetApplier(
    policy(fixture.source, fixture.sha),
    fixture.remote,
    { async latestRunForSha() { return null; } }
  );
  t.after(() => applier.dispose());

  const receipt = await applier.applyAndPush({
    operationId: "op-20260909-0001",
    grant: grant(),
    operations: [{ path: "allowed/module.txt", content: "version 2\n" }]
  });

  assert.match(receipt.commitSha, /^[0-9a-f]{40}$/);
  assert.notEqual(receipt.commitSha, fixture.sha);
  assert.equal(receipt.branch, "main");
  assert.deepEqual(receipt.changedPaths, ["allowed/module.txt"]);

  // The remote now serves the exact pushed commit.
  const remoteHead = await git(["rev-parse", "main"], fixture.remote, cleanEnv);
  assert.equal(remoteHead, receipt.commitSha);

  // The source repository remains untouched.
  const sourceHead = await git(["rev-parse", "HEAD"], fixture.source, cleanEnv);
  assert.equal(sourceHead, fixture.sha);
});

test("B13.b1 refuses grants that do not match the policy and invalid operation ids", async (t) => {
  const fixture = await fixtureRepository();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const applier = new BoundedChangeSetApplier(
    policy(fixture.source, fixture.sha),
    fixture.remote,
    { async latestRunForSha() { return null; } }
  );
  t.after(() => applier.dispose());

  await assert.rejects(
    applier.applyAndPush({
      operationId: "short",
      grant: grant(),
      operations: [{ path: "allowed/module.txt", content: "version 2\n" }]
    }),
    (error) => error instanceof ChangeSetError && error.code === "invalid_change_set"
  );

  await assert.rejects(
    applier.applyAndPush({
      operationId: "op-20260909-0002",
      grant: { ...grant(), targetBranch: "other-branch" },
      operations: [{ path: "allowed/module.txt", content: "version 2\n" }]
    }),
    (error) => error instanceof ChangeSetError && error.code === "push_not_authorized"
  );

  await assert.rejects(
    applier.applyAndPush({
      operationId: "op-20260909-0003",
      grant: { ...grant(), repositoryId: "other/owner" },
      operations: [{ path: "allowed/module.txt", content: "version 2\n" }]
    }),
    (error) => error instanceof ChangeSetError && error.code === "push_not_authorized"
  );
});

test("B13.b1 CI reconciliation requires a run at the exact pushed SHA", async (t) => {
  const fixture = await fixtureRepository();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const applier = new BoundedChangeSetApplier(
    policy(fixture.source, fixture.sha),
    fixture.remote,
    { async latestRunForSha() { return null; } }
  );
  t.after(() => applier.dispose());

  const receipt = await applier.applyAndPush({
    operationId: "op-20260909-0004",
    grant: grant(),
    operations: [{ path: "allowed/module.txt", content: "version 3\n" }]
  });

  await assert.rejects(
    applier.reconcileWithCi("main", receipt.commitSha),
    (error) => error instanceof ChangeSetError && error.code === "ci_reconciliation_failed"
  );

  const matching = new BoundedChangeSetApplier(
    policy(fixture.source, fixture.sha),
    fixture.remote,
    { async latestRunForSha(branch, sha) { return { runId: "r1", headSha: sha, conclusion: "success" }; } }
  );
  const outcome = await matching.reconcileWithCi("main", receipt.commitSha);
  assert.equal(outcome.conclusion, "success");
  assert.equal(outcome.headSha, receipt.commitSha);
});
