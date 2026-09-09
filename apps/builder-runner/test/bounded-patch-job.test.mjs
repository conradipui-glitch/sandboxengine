import assert from "node:assert/strict";
import test from "node:test";
import { createBuilderWorkspacePolicy } from "../dist/workspace-policy.js";
import { applyBoundedPatch, BoundedPatchError } from "../dist/bounded-patch-job.js";

const SHA = "a".repeat(40);

function policy() {
  return createBuilderWorkspacePolicy({
    repositoryId: "owner/project",
    repositoryRoot: "/tmp/repository",
    baseBranch: "main",
    baseCommitSha: SHA,
    readablePaths: ["apps/builder-runner"],
    writablePaths: ["apps/builder-runner/src", "apps/builder-runner/test"],
    verificationCommands: [{ executable: "npm", args: ["run", "test:builder"] }]
  });
}

test("B13.a2 records bounded patch evidence and only returns allowed paths", async () => {
  const writes = [];
  const evidence = await applyBoundedPatch({
    baseCommitSha: SHA,
    async readText() { return ""; },
    async writeText(path, content) { writes.push({ path, content }); },
    async treeIdentity() { return "tree-hash"; }
  }, policy(), [{ path: "apps/builder-runner/src/new.ts", content: "export {};" }]);

  assert.deepEqual(writes, [{ path: "apps/builder-runner/src/new.ts", content: "export {};" }]);
  assert.equal(evidence.baseCommitSha, SHA);
  assert.deepEqual(evidence.changedPaths, ["apps/builder-runner/src/new.ts"]);
  assert.match(evidence.diffHash, /^[0-9a-f]{64}$/);
  assert.equal(evidence.treeHash, "tree-hash");
});

test("B13.a2 rejects empty patches and policy escalation", async () => {
  const workspace = {
    baseCommitSha: SHA,
    async readText() { return ""; },
    async writeText() {},
    async treeIdentity() { return "tree"; }
  };

  await assert.rejects(
    applyBoundedPatch(workspace, policy(), []),
    (error) => error instanceof BoundedPatchError && error.code === "empty_patch"
  );

  await assert.rejects(
    applyBoundedPatch(workspace, policy(), [{ path: "packages/contracts/outside.ts", content: "x" }]),
    (error) => error.code === "path_not_allowed"
  );
});
