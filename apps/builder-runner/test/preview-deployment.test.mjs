import assert from "node:assert/strict";
import test from "node:test";
import { createPreviewDeploymentPolicy, createGhPreviewDeploymentGateway, PreviewDeploymentAdapter, PreviewDeploymentError } from "../dist/preview-deployment.js";

const SHA = "b".repeat(40);

function policy() {
  return createPreviewDeploymentPolicy({
    target: {
      repositoryId: "owner/repo",
      workflowFile: "deploy-preview.yml",
      ref: "feature/preview-branch"
    },
    requiredCommitSha: SHA,
    smokeUrl: "https://preview.example.com/healthz",
    smokeExpectSubstring: "ok"
  });
}

function fakeGateway(overrides = {}) {
  return {
    async dispatchWorkflow(target, commitSha) {
      if (!target || commitSha !== SHA) throw new Error("bad dispatch");
      return "run-1";
    },
    async waitForRunConclusion(runId, commitSha) {
      assert.equal(commitSha, SHA);
      return "success";
    },
    async fetchText(url) {
      return "status: ok";
    },
    ...overrides
  };
}

test("B13.b2 adapter deploys the exact artifact, reconciles the run and passes smoke", async () => {
  const adapter = new PreviewDeploymentAdapter(policy(), fakeGateway());
  const receipt = await adapter.deploy();
  assert.equal(receipt.runId, "run-1");
  assert.equal(receipt.artifactCommitSha, SHA);
  assert.equal(receipt.smokePassed, true);
  assert.equal(receipt.smokeUrl, "https://preview.example.com/healthz");
  assert.match(receipt.deploymentId, /^preview-/);
});

test("B13.b2 refuses artifact drift, failed runs and failed smoke", async () => {
  const adapter = new PreviewDeploymentAdapter(policy(), fakeGateway());

  await assert.rejects(
    adapter.deploy(createPreviewDeploymentPolicy({
      target: { repositoryId: "owner/repo", workflowFile: "deploy-preview.yml", ref: "feature/preview-branch" },
      requiredCommitSha: "c".repeat(40),
      smokeUrl: "https://preview.example.com/healthz",
      smokeExpectSubstring: "ok"
    })),
    (error) => error instanceof PreviewDeploymentError && error.code === "deployment_not_authorized"
  );

  const failedRun = new PreviewDeploymentAdapter(policy(), fakeGateway({
    async waitForRunConclusion() { return "failure"; }
  }));
  await assert.rejects(
    failedRun.deploy(),
    (error) => error instanceof PreviewDeploymentError && error.code === "deployment_reconciliation_failed"
  );

  const failedSmoke = new PreviewDeploymentAdapter(policy(), fakeGateway({
    async fetchText() { return "internal error"; }
  }));
  await assert.rejects(
    failedSmoke.deploy(),
    (error) => error instanceof PreviewDeploymentError && error.code === "smoke_failed"
  );

  const smokeError = new PreviewDeploymentAdapter(policy(), fakeGateway({
    async fetchText() { throw new Error("ECONNREFUSED"); }
  }));
  await assert.rejects(
    smokeError.deploy(),
    (error) => error instanceof PreviewDeploymentError && error.code === "smoke_failed"
  );
});

test("B13.b2 reconcileLostResponse restores an existing successful run without a new dispatch", async () => {
  const dispatches = [];
  const g = fakeGateway({
    async dispatchWorkflow(target, commitSha) { dispatches.push(commitSha); return "run-x"; }
  });
  const adapter = new PreviewDeploymentAdapter(policy(), g);

  const receipt = await adapter.reconcileLostResponse(async (sha) => {
    assert.equal(sha, SHA);
    return "run-existing";
  });
  assert.equal(receipt.deploymentId, "preview-run-existing");
  assert.equal(receipt.artifactCommitSha, SHA);
  assert.equal(receipt.smokePassed, true);
  assert.deepEqual(dispatches, []);

  const none = await adapter.reconcileLostResponse(async () => null);
  assert.equal(none, null);

  const failedRun = new PreviewDeploymentAdapter(policy(), fakeGateway({
    async waitForRunConclusion() { return "failure"; }
  }));
  const stillNone = await failedRun.reconcileLostResponse(async () => "run-y");
  assert.equal(stillNone, null);
});

test("B13.b2 policy rejects malformed targets and smoke expectations", () => {
  assert.throws(
    () => createPreviewDeploymentPolicy({
      target: { repositoryId: "owner/repo/extra", workflowFile: "deploy-preview.yml", ref: "main" },
      requiredCommitSha: SHA,
      smokeUrl: "https://x.example.com/",
      smokeExpectSubstring: "ok"
    }),
    (error) => error instanceof PreviewDeploymentError && error.code === "deployment_invalid_input"
  );
  assert.throws(
    () => createPreviewDeploymentPolicy({
      target: { repositoryId: "owner/repo", workflowFile: "../../etc/passwd", ref: "main" },
      requiredCommitSha: SHA,
      smokeUrl: "https://x.example.com/",
      smokeExpectSubstring: "ok"
    }),
    (error) => error instanceof PreviewDeploymentError && error.code === "deployment_invalid_input"
  );
  assert.throws(
    () => createPreviewDeploymentPolicy({
      target: { repositoryId: "owner/repo", workflowFile: "deploy-preview.yml", ref: "../escape" },
      requiredCommitSha: SHA,
      smokeUrl: "https://x.example.com/",
      smokeExpectSubstring: "ok"
    }),
    (error) => error instanceof PreviewDeploymentError && error.code === "deployment_invalid_input"
  );
  assert.throws(
    () => createPreviewDeploymentPolicy({
      target: { repositoryId: "owner/repo", workflowFile: "deploy-preview.yml", ref: "main" },
      requiredCommitSha: "not-a-sha",
      smokeUrl: "https://x.example.com/",
      smokeExpectSubstring: "ok"
    }),
    (error) => error instanceof PreviewDeploymentError && error.code === "deployment_invalid_input"
  );
  assert.throws(
    () => createPreviewDeploymentPolicy({
      target: { repositoryId: "owner/repo", workflowFile: "deploy-preview.yml", ref: "main" },
      requiredCommitSha: SHA,
      smokeUrl: "ftp://x.example.com/",
      smokeExpectSubstring: "ok"
    }),
    (error) => error instanceof PreviewDeploymentError && error.code === "deployment_invalid_input"
  );
  assert.throws(
    () => createPreviewDeploymentPolicy({
      target: { repositoryId: "owner/repo", workflowFile: "deploy-preview.yml", ref: "main" },
      requiredCommitSha: SHA,
      smokeUrl: "https://x.example.com/",
      smokeExpectSubstring: ""
    }),
    (error) => error instanceof PreviewDeploymentError && error.code === "deployment_invalid_input"
  );
});

// Находка полного ревью: в конструкторе адаптера стояла тавтология
// `policy.target.repositoryId !== policy.target.repositoryId` — никогда не истинна,
// то есть проверка не работала вообще. Здесь она доказана живой.
test("B13.b2 adapter refuses a hand-assembled target and a foreign repository", () => {
  assert.throws(
    () => new PreviewDeploymentAdapter(
      { target: { repositoryId: "owner/repo", workflowFile: "deploy-preview.yml", ref: "../escape" }, requiredCommitSha: SHA, smokeUrl: "https://preview.example.com/healthz", smokeExpectSubstring: "ok" },
      fakeGateway()
    ),
    (error) => error instanceof PreviewDeploymentError && error.code === "deployment_invalid_input"
  );

  assert.throws(
    () => new PreviewDeploymentAdapter(policy(), { ...fakeGateway(), repositoryId: "other/repo" }),
    (error) => error instanceof PreviewDeploymentError && error.code === "deployment_not_authorized"
  );

  // Шлюз `gh` знает свой репозиторий и отказывает чужой цели до вызова gh.
  const gateway = createGhPreviewDeploymentGateway("owner/repo");
  assert.equal(gateway.repositoryId, "owner/repo");
  const runner = new PreviewDeploymentAdapter(policy(), gateway);
  assert.ok(runner instanceof PreviewDeploymentAdapter);
  return assert.rejects(
    () => gateway.dispatchWorkflow({ repositoryId: "other/repo", workflowFile: "deploy-preview.yml", ref: "main" }, SHA),
    /not the repository this gateway is authorized for/
  );
});
