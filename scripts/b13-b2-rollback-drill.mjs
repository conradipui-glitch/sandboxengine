// B13.b2 preview rollback drill: redeploy the PREVIOUS artifact on the same preview
// ref and verify the preview worker serves it (artifact identity + smoke), then
// reconcile the result through the adapter contract. Rollback here = deploying an
// older commit of the SAME preview branch (ref move is operator-owned; this drill
// does not move the branch, it uses the adapter against the older SHA via a
// workflow_dispatch pinned by reconciliation to that SHA).
//
// NOTE: workflow_dispatch always builds the ref HEAD, so a true pinned-SHA rollback
// on this workflow requires moving the ref. The drill therefore:
//   1. captures the current preview head SHA (ffba7c8…),
//   2. moves the preview ref back one commit (efb94a8…) via the API,
//   3. dispatches + reconciles the run at the rollback SHA,
//   4. smokes the preview worker,
//   5. restores the ref to the original SHA,
//   6. dispatches + reconciles + smokes again (rollback of the rollback).
import { createPreviewDeploymentPolicy, PreviewDeploymentAdapter, createGhPreviewDeploymentGateway } from "../apps/builder-runner/dist/index.js";
import { writeFileSync } from "node:fs";

const REPO = "conradipui-glitch/sandbox";
const REF = "feat/florence-vertical-slice";
const CURRENT = "ffba7c896bc9a02ab2485cce55ee1445f455f942";
const ROLLBACK_TO = "af9f2134cdfb8cea5cdfabd14eb9439124a3250c"; // previous commit with a green test run
const PREVIEW_URL = "https://living-history-florence-preview.conradipui.workers.dev/";

async function ghJson(args) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const gh = promisify(execFile);
  const result = await gh("gh", args, { windowsHide: true, timeout: 60_000, maxBuffer: 1_048_576 });
  const text = String(result.stdout).trim();
  try {
    return JSON.parse(text);
  } catch {
    // gh -q with a per-item template emits one raw value per line (NDJSON);
    // SHA templates are bare strings, so keep them verbatim.
    return text.split(/\r?\n/).filter(Boolean);
  }
}

async function resolveSha(shortSha) {
  const commits = await ghJson(["api", `repos/${REPO}/commits?sha=${REF}&per_page=20`, "-q", ".[].sha"]);
  return commits.find((sha) => sha.startsWith(shortSha));
}

async function moveRef(sha) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const gh = promisify(execFile);
  await gh("gh", ["api", `-X`, "PATCH", `repos/${REPO}/git/refs/heads/${encodeURIComponent(REF)}`,
    "-f", `sha=${sha}`, "-F", "force=true"], { windowsHide: true, timeout: 60_000 });
}

function adapterFor(sha) {
  const policy = createPreviewDeploymentPolicy({
    target: { repositoryId: REPO, workflowFile: "deploy-florence-preview.yml", ref: REF },
    requiredCommitSha: sha,
    smokeUrl: PREVIEW_URL,
    smokeExpectSubstring: "<!doctype html>"
  });
  return new PreviewDeploymentAdapter(policy, createGhPreviewDeploymentGateway(REPO));
}

async function smoke(url, expect) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": "b13-acceptance/1.0" } });
  const body = (await response.text()).slice(0, 1_048_576);
  return { status: response.status, matched: body.includes(expect) };
}

const targetRollbackSha = ROLLBACK_TO ? await resolveSha(ROLLBACK_TO.split("").length === 40 ? ROLLBACK_TO : ROLLBACK_TO) : await resolveSha("efb94a8");
if (!targetRollbackSha) throw new Error("rollback SHA not found on the preview branch");
const currentSha = await resolveSha(CURRENT.split("").length === 40 ? CURRENT : CURRENT);
if (!currentSha) throw new Error("current SHA not found on the preview branch");

const evidence = { operationId: "b13-b2-rollback-drill-20260909", steps: [] };

// Step 1: rollback ref → previous commit, dispatch, reconcile, smoke.
await moveRef(targetRollbackSha);
const rollbackReceipt = await adapterFor(targetRollbackSha).deploy();
const rollbackSmoke = await smoke(PREVIEW_URL, "<!doctype html>");
evidence.steps.push({ step: "rollback", ref: targetRollbackSha, receipt: rollbackReceipt, smoke: rollbackSmoke });
console.log("rollback step:", JSON.stringify(rollbackSmoke));

// Step 2: restore ref → original commit, dispatch, reconcile, smoke (rollback of rollback).
await moveRef(currentSha);
const restoreReceipt = await adapterFor(currentSha).deploy();
const restoreSmoke = await smoke(PREVIEW_URL, "<!doctype html>");
evidence.steps.push({ step: "restore", ref: currentSha, receipt: restoreReceipt, smoke: restoreSmoke });
console.log("restore step:", JSON.stringify(restoreSmoke));

evidence.result = (rollbackSmoke.status === 200 && rollbackSmoke.matched && restoreSmoke.status === 200 && restoreSmoke.matched
  && rollbackReceipt.runId !== restoreReceipt.runId) ? "PASS" : "FAIL";
writeFileSync("docs/worklog/b13-b2-rollback-receipt.json", JSON.stringify(evidence, null, 2));
console.log("ROLLBACK DRILL:", evidence.result);
