
import { createPreviewDeploymentPolicy, PreviewDeploymentAdapter, createGhPreviewDeploymentGateway } from "../apps/builder-runner/dist/index.js";
import { writeFileSync } from "node:fs";

const policy = createPreviewDeploymentPolicy({
  target: { repositoryId: "conradipui-glitch/sandbox", workflowFile: "deploy-florence-preview.yml", ref: "feat/florence-vertical-slice" },
  requiredCommitSha: "ffba7c896bc9a02ab2485cce55ee1445f455f942",
  smokeUrl: "https://living-history-florence-preview.conradipui.workers.dev/",
  smokeExpectSubstring: "<!doctype html>"
});

const gateway = createGhPreviewDeploymentGateway("conradipui-glitch/sandbox");
const adapter = new PreviewDeploymentAdapter(policy, gateway);
const receipt = await adapter.deploy();
const out = {
  operationId: "b13-b2-live-acceptance-20260909",
  receipt,
  gateway: "gh-cli",
  note: "live dispatch through B13.b2 adapter; workflow deploys the ref HEAD"
};
writeFileSync("docs/worklog/b13-b2-live-receipt.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
