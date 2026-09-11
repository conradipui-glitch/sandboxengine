// B13.b2 live acceptance: dispatch the preview deployment through the shared
// PreviewDeploymentAdapter (gh-cli gateway) and persist the reconciliation receipt.
//
// EXIT CODE CONTRACT (via scripts/lib/drill-harness.mjs): a receipt carrying a run
// id is PASS and exits 0; a receipt without one is FAIL and exits non-zero, so a
// silent, unreconciled deployment can never be reported as accepted.
//
// Offline fixture mode (tests / dry runs only, NO network, NO deploy):
//   B13_B2_LIVE_ACCEPTANCE_FIXTURE=<path>       JSON: { receipt: { runId, ... } }
//   B13_B2_LIVE_ACCEPTANCE_RECEIPT_PATH=<path>  optional receipt output path override
import {
  computeVerdict,
  isMainModule,
  loadFixture,
  offlineFixture,
  reportDrill,
  resolveReceiptPath
} from "./lib/drill-harness.mjs";

const FIXTURE_ENV = "B13_B2_LIVE_ACCEPTANCE_FIXTURE";
const RECEIPT_ENV = "B13_B2_LIVE_ACCEPTANCE_RECEIPT_PATH";
const DEFAULT_RECEIPT_PATH = "docs/worklog/b13-b2-live-receipt.json";
const OPERATION_ID = "b13-b2-live-acceptance-20260909";

export function computeLiveAcceptanceVerdict(receipt) {
  return computeVerdict(receipt !== null && receipt !== undefined && receipt.runId !== undefined && receipt.runId !== null);
}

export async function run({ fixturePath } = {}) {
  if (fixturePath) {
    const fixture = loadFixture(fixturePath);
    const receipt = fixture.receipt ?? fixture;
    const out = {
      operationId: OPERATION_ID,
      receipt,
      gateway: "offline-fixture",
      note: "offline fixture: adapter and gh gateway are not invoked"
    };
    reportDrill({
      label: "LIVE ACCEPTANCE",
      result: computeLiveAcceptanceVerdict(receipt),
      evidence: out,
      receiptPath: resolveReceiptPath({ envVar: RECEIPT_ENV, defaultPath: DEFAULT_RECEIPT_PATH, fixtureMode: true }),
      printJson: true
    });
    return out;
  }

  // Lazy import: keeps the offline fixture path free of the builder-runner build.
  const { createPreviewDeploymentPolicy, PreviewDeploymentAdapter, createGhPreviewDeploymentGateway } =
    await import("../apps/builder-runner/dist/index.js");

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
    operationId: OPERATION_ID,
    receipt,
    gateway: "gh-cli",
    note: "live dispatch through B13.b2 adapter; workflow deploys the ref HEAD"
  };
  reportDrill({
    label: "LIVE ACCEPTANCE",
    result: computeLiveAcceptanceVerdict(receipt),
    evidence: out,
    receiptPath: resolveReceiptPath({ envVar: RECEIPT_ENV, defaultPath: DEFAULT_RECEIPT_PATH }),
    printJson: true
  });
  return out;
}

if (isMainModule(import.meta.url)) {
  await run({ fixturePath: offlineFixture({ envVar: FIXTURE_ENV }) });
}
