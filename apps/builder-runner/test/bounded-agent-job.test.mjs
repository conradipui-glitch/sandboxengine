import assert from "node:assert/strict";
import test from "node:test";
import { createBuilderWorkspacePolicy } from "../dist/workspace-policy.js";
import { runBoundedAgentJob } from "../dist/bounded-agent-job.js";

const SHA = "a".repeat(40);

test("B13.a2 bounded agent job applies patch and runs only policy verification commands", async () => {
  const writes = [];
  const verified = [];

  const result = await runBoundedAgentJob(
    {
      baseCommitSha: SHA,
      async readText() { return ""; },
      async writeText(path, content) { writes.push({ path, content }); },
      async treeIdentity() { return "tree"; }
    },
    createBuilderWorkspacePolicy({
      repositoryId: "owner/project",
      repositoryRoot: "/tmp/repository",
      baseBranch: "main",
      baseCommitSha: SHA,
      readablePaths: ["apps/builder-runner"],
      writablePaths: ["apps/builder-runner/src"],
      verificationCommands: [{ executable: "npm", args: ["run", "test:builder"] }]
    }),
    [{ path: "apps/builder-runner/src/generated.ts", content: "export {};" }],
    {
      async run(executable, args) {
        verified.push([executable, ...args].join(" "));
      }
    }
  );

  assert.deepEqual(writes, [{ path: "apps/builder-runner/src/generated.ts", content: "export {};" }]);
  assert.deepEqual(verified, ["npm run test:builder"]);
  assert.deepEqual(result.verifiedCommands, ["npm run test:builder"]);
  assert.equal(result.patch.treeHash, "tree");
});
