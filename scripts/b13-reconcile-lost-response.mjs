
import { createPreviewDeploymentPolicy, PreviewDeploymentAdapter, createGhPreviewDeploymentGateway } from "../apps/builder-runner/dist/index.js";
import { writeFileSync } from "node:fs";

const policy = createPreviewDeploymentPolicy({
  target: { repositoryId: "conradipui-glitch/sandbox", workflowFile: "deploy-florence-preview.yml", ref: "feat/florence-vertical-slice" },
  requiredCommitSha: "ffba7c896bc9a02ab2485cce55ee1445f455f942",
  smokeUrl: "https://living-history-florence-preview.conradipui.workers.dev/",
  smokeExpectSubstring: "<!doctype html>"
});
const adapter = new PreviewDeploymentAdapter(policy, createGhPreviewDeploymentGateway("conradipui-glitch/sandbox"));

const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const gh = promisify(execFile);
async function findRunForSha(sha) {
  const res = await gh("gh", ["run", "list", "--repo", "conradipui-glitch/sandbox", "--workflow", "deploy-florence-preview.yml", "--limit", "30", "--json", "databaseId,headSha,status,conclusion"], { windowsHide: true, timeout: 30000, maxBuffer: 1048576 });
  const runs = JSON.parse(res.stdout);
  const match = runs.find((r) => r.headSha === sha && r.status === "completed" && r.conclusion === "success");
  return match ? String(match.databaseId) : null;
}

const receipt = await adapter.reconcileLostResponse(findRunForSha);
const evidence = {
  operationId: "b13-reconcile-lost-response-20260909",
  method: "PreviewDeploymentAdapter.reconcileLostResponse over gh gateway; no dispatch performed",
  receipt
};
writeFileSync("docs/worklog/b13-reconcile-lost-response-receipt.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
