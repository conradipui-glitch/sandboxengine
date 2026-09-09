import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  authorizeBuilderPath,
  BuilderPolicyError,
  createBuilderWorkspacePolicy
} from "../dist/workspace-policy.js";

const SHA = "a".repeat(40);

function policy(overrides = {}) {
  return createBuilderWorkspacePolicy({
    repositoryId: "owner/project",
    repositoryRoot: resolve("fixtures/repository"),
    baseBranch: "main",
    baseCommitSha: SHA,
    readablePaths: ["apps/builder-runner", "packages/contracts"],
    writablePaths: ["apps/builder-runner/src", "apps/builder-runner/test"],
    verificationCommands: [{ executable: "npm", args: ["run", "test:builder"] }],
    ...overrides
  });
}

test("B13.0 accepts exact repo identity and resolves only task-authorized paths", () => {
  const value = policy();
  assert.equal(value.repositoryId, "owner/project");
  assert.equal(value.baseCommitSha, SHA);
  assert.equal(
    authorizeBuilderPath(value, "apps/builder-runner/src/workspace-policy.ts", "write"),
    "apps/builder-runner/src/workspace-policy.ts"
  );
  assert.equal(
    authorizeBuilderPath(value, "packages/contracts/schemas/v1/Block.schema.json", "read"),
    "packages/contracts/schemas/v1/Block.schema.json"
  );
});

test("B13.0 rejects traversal, absolute paths, Git metadata and prefix collisions", () => {
  const value = policy();
  for (const candidate of [
    "../secrets.txt",
    "apps/builder-runner/../../secrets.txt",
    "/etc/passwd",
    "C:/Windows/System32/config/SAM",
    "apps\\builder-runner\\src\\escape.ts",
    ".git/config",
    "apps/builder-runner-copy/src/index.ts"
  ]) {
    assert.throws(() => authorizeBuilderPath(value, candidate, "read"), BuilderPolicyError, candidate);
  }
});

test("B13.0 refuses write escalation and malformed repository snapshots", () => {
  const value = policy();
  assert.throws(
    () => authorizeBuilderPath(value, "packages/contracts/schemas/v1/Block.schema.json", "write"),
    (error) => error instanceof BuilderPolicyError && error.code === "path_not_allowed"
  );
  assert.throws(() => policy({ baseCommitSha: "main" }), BuilderPolicyError);
  assert.throws(() => policy({ repositoryId: "owner/project/extra" }), BuilderPolicyError);
  assert.throws(() => policy({ repositoryId: "../project" }), BuilderPolicyError);
  assert.throws(() => policy({ baseBranch: "refs/heads/main.lock" }), BuilderPolicyError);
  assert.throws(() => policy({ writablePaths: ["apps/studio"] }), BuilderPolicyError);
  assert.throws(() => policy({ readablePaths: [".git"] }), BuilderPolicyError);
  assert.throws(() => policy({ readablePaths: ["vendor/plugin/.git"] }), BuilderPolicyError);
  assert.throws(
    () => policy({ verificationCommands: [{ executable: "npm run verify", args: [] }] }),
    BuilderPolicyError
  );
});
