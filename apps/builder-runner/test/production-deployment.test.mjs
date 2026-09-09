import assert from "node:assert/strict";
import test from "node:test";
import {
  createProductionDeploymentPolicy,
  ProductionDeploymentAdapter,
  ProductionDeploymentError
} from "../dist/production-deployment.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function policy() {
  return createProductionDeploymentPolicy({
    target: { repositoryId: "owner/repo", workflowFile: "deploy.yml", ref: "main" },
    smokeUrl: "https://app.example.com/healthz",
    smokeExpectSubstring: "ok",
    maxConcurrentDeployments: 1
  });
}

function grant(sha) {
  return { commitSha: sha, authorizedBy: "Anton", reason: "B13.c1 acceptance" };
}

function gateway(overrides = {}) {
  return {
    async dispatchWorkflow(target, commitSha) { return `run-${commitSha[0]}`; },
    async waitForRunConclusion(runId, commitSha) { return "success"; },
    async fetchText(url) { return "status: ok"; },
    ...overrides
  };
}

test("B13.c1 production deploy requires a grant, reconciles the run and passes smoke", async () => {
  const adapter = new ProductionDeploymentAdapter(policy(), gateway());
  const receipt = await adapter.deploy(grant(SHA_A));
  assert.equal(receipt.deploymentId, "production-run-a");
  assert.equal(receipt.artifactCommitSha, SHA_A);
  assert.equal(receipt.authorizedBy, "Anton");
  assert.equal(receipt.smokePassed, true);
});

test("B13.c1 reconcileLostResponse returns the existing receipt without a new dispatch", async () => {
  const dispatches = [];
  const g = gateway({
    async dispatchWorkflow(target, commitSha) { dispatches.push(commitSha); return `run-${commitSha[0]}`; }
  });
  const adapter = new ProductionDeploymentAdapter(policy(), g);

  const reconciled = await adapter.reconcileLostResponse(grant(SHA_A), async (sha) => "run-lost");
  assert.equal(reconciled.deploymentId, "production-run-lost");
  assert.deepEqual(dispatches, []);

  const none = await adapter.reconcileLostResponse(grant(SHA_B), async () => null);
  assert.equal(none, null);

  const failedRun = new ProductionDeploymentAdapter(policy(), gateway({
    async waitForRunConclusion() { return "failure"; }
  }));
  const stillNone = await failedRun.reconcileLostResponse(grant(SHA_B), async () => "run-x");
  assert.equal(stillNone, null);
});

test("B13.c1 verified rollback moves to a different SHA and refuses same-SHA rollback", async () => {
  const adapter = new ProductionDeploymentAdapter(policy(), gateway());
  const receipt = await adapter.rollback(SHA_A, grant(SHA_B));
  assert.equal(receipt.rollbackId, "rollback-run-b");
  assert.equal(receipt.fromCommitSha, SHA_A);
  assert.equal(receipt.toCommitSha, SHA_B);
  assert.equal(receipt.smokePassed, true);

  await assert.rejects(
    adapter.rollback(SHA_A, grant(SHA_A)),
    (error) => error instanceof ProductionDeploymentError && error.code === "rollback_not_authorized"
  );
});

test("B13.c1 production failures fail closed: bad grant, failed run, failed smoke", async () => {
  const adapter = new ProductionDeploymentAdapter(policy(), gateway());

  await assert.rejects(
    adapter.deploy(grant("not-a-sha")),
    (error) => error instanceof ProductionDeploymentError && error.code === "production_invalid_input"
  );
  await assert.rejects(
    adapter.deploy({ commitSha: SHA_A, authorizedBy: "Anton", reason: "" }),
    (error) => error instanceof ProductionDeploymentError && error.code === "production_invalid_input"
  );

  const failedRun = new ProductionDeploymentAdapter(policy(), gateway({
    async waitForRunConclusion() { return "failure"; }
  }));
  await assert.rejects(
    failedRun.deploy(grant(SHA_A)),
    (error) => error instanceof ProductionDeploymentError && error.code === "production_reconciliation_failed"
  );

  const failedSmoke = new ProductionDeploymentAdapter(policy(), gateway({
    async fetchText() { return "error"; }
  }));
  await assert.rejects(
    failedSmoke.deploy(grant(SHA_A)),
    (error) => error instanceof ProductionDeploymentError && error.code === "production_smoke_failed"
  );

  const failedRollbackSmoke = new ProductionDeploymentAdapter(policy(), gateway({
    async fetchText() { throw new Error("ECONNREFUSED"); }
  }));
  await assert.rejects(
    failedRollbackSmoke.rollback(SHA_A, grant(SHA_B)),
    (error) => error instanceof ProductionDeploymentError && error.code === "rollback_smoke_failed"
  );
});

test("B13.c1 production policy validation is strict", () => {
  assert.throws(
    () => createProductionDeploymentPolicy({
      target: { repositoryId: "owner/repo", workflowFile: "deploy.yml", ref: "main" },
      smokeUrl: "https://x.example.com/",
      smokeExpectSubstring: "ok",
      maxConcurrentDeployments: 2
    }),
    (error) => error instanceof ProductionDeploymentError && error.code === "production_invalid_input"
  );
  assert.throws(
    () => createProductionDeploymentPolicy({
      target: { repositoryId: "owner/repo", workflowFile: "deploy.yml", ref: "../x" },
      smokeUrl: "https://x.example.com/",
      smokeExpectSubstring: "ok",
      maxConcurrentDeployments: 1
    }),
    (error) => error instanceof ProductionDeploymentError && error.code === "production_invalid_input"
  );
});
