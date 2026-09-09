// B13.c1 — production deployment policy with lost-response reconciliation and a
// verified rollback. Production is a separate, stricter policy than preview:
// an explicit production grant per artifact SHA is REQUIRED, the adapter refuses
// to deploy without it, and rollback is a first-class receipt-carrying operation.
// This module never touches Cloudflare credentials; the gateway abstracts them.

import type { PreviewDeploymentGateway, PreviewDeploymentTarget } from "./preview-deployment.js";

export type ProductionDeploymentErrorCode =
  | "production_invalid_input"
  | "production_not_authorized"
  | "production_reconciliation_failed"
  | "production_smoke_failed"
  | "rollback_invalid_input"
  | "rollback_not_authorized"
  | "rollback_reconciliation_failed"
  | "rollback_smoke_failed";

export class ProductionDeploymentError extends Error {
  constructor(readonly code: ProductionDeploymentErrorCode, message: string, readonly details?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "ProductionDeploymentError";
  }
}

export interface ProductionGrant {
  /** Exact artifact SHA this grant authorizes for production. */
  readonly commitSha: string;
  /** Who authorized it (bounded display identity, no credentials). */
  readonly authorizedBy: string;
  /** Bounded reason recorded in the receipt. */
  readonly reason: string;
}

export interface ProductionDeploymentPolicyInput {
  readonly target: PreviewDeploymentTarget;
  readonly smokeUrl: string;
  readonly smokeExpectSubstring: string;
  /** Production runs must observe the workflow run succeeded for THIS exact SHA. */
  readonly maxConcurrentDeployments: 1;
}

export interface ProductionDeploymentPolicy extends ProductionDeploymentPolicyInput {}

export function createProductionDeploymentPolicy(input: ProductionDeploymentPolicyInput): ProductionDeploymentPolicy {
  const parts = input.target.repositoryId.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ProductionDeploymentError("production_invalid_input", "target repositoryId must be owner/repo");
  }
  if (!/^[\w.-]+\.ya?ml$/.test(input.target.workflowFile)) {
    throw new ProductionDeploymentError("production_invalid_input", "workflowFile must be a bounded workflow file name");
  }
  if (!/^[\w./-]{1,200}$/.test(input.target.ref) || input.target.ref.includes("..")) {
    throw new ProductionDeploymentError("production_invalid_input", "ref is invalid");
  }
  if (input.maxConcurrentDeployments !== 1) {
    throw new ProductionDeploymentError("production_invalid_input", "production allows exactly one concurrent deployment");
  }
  let smokeUrl: URL;
  try {
    smokeUrl = new URL(input.smokeUrl);
  } catch {
    throw new ProductionDeploymentError("production_invalid_input", "smokeUrl must be an absolute URL");
  }
  if (smokeUrl.protocol !== "https:" && smokeUrl.protocol !== "http:") {
    throw new ProductionDeploymentError("production_invalid_input", "smokeUrl must be http(s)");
  }
  if (typeof input.smokeExpectSubstring !== "string" || input.smokeExpectSubstring.length === 0 || input.smokeExpectSubstring.length > 200) {
    throw new ProductionDeploymentError("production_invalid_input", "smokeExpectSubstring must be a bounded non-empty string");
  }
  return Object.freeze({ ...input });
}

export function assertProductionGrant(grant: ProductionGrant): void {
  if (!/^[0-9a-f]{40}$/.test(grant.commitSha)) {
    throw new ProductionDeploymentError("production_invalid_input", "grant.commitSha must be an exact lowercase Git SHA-1");
  }
  if (!/^[\w .-]{1,100}$/.test(grant.authorizedBy)) {
    throw new ProductionDeploymentError("production_invalid_input", "grant.authorizedBy is invalid");
  }
  if (typeof grant.reason !== "string" || grant.reason.length === 0 || grant.reason.length > 300 || grant.reason.includes("\n") || grant.reason.includes("\r")) {
    throw new ProductionDeploymentError("production_invalid_input", "grant.reason is invalid");
  }
}

export interface ProductionDeploymentReceipt {
  readonly deploymentId: string;
  readonly runId: string;
  readonly artifactCommitSha: string;
  readonly smokeUrl: string;
  readonly smokePassed: true;
  readonly authorizedBy: string;
  readonly reason: string;
}

export interface ProductionRollbackReceipt {
  readonly rollbackId: string;
  readonly runId: string;
  readonly fromCommitSha: string;
  readonly toCommitSha: string;
  readonly smokeUrl: string;
  readonly smokePassed: true;
}

const PRODUCTION_DEPLOYMENT_TIMEOUT_MS = 900_000;

/**
 * Production adapter: same single-workflow mechanics as preview, but every deploy
 * needs an explicit per-SHA production grant, and rollback is verified by smoke.
 * Lost responses are reconciled: the deployment ID is derived from the workflow run,
 * so re-running reconciliation finds the same run instead of deploying twice.
 */
export class ProductionDeploymentAdapter {
  constructor(
    private readonly policy: ProductionDeploymentPolicy,
    private readonly gateway: PreviewDeploymentGateway
  ) {}

  async deploy(grant: ProductionGrant): Promise<ProductionDeploymentReceipt> {
    assertProductionGrant(grant);
    let runId: string;
    try {
      runId = await this.gateway.dispatchWorkflow(this.policy.target, grant.commitSha);
    } catch (error) {
      throw new ProductionDeploymentError("production_reconciliation_failed", `workflow dispatch failed: ${summarize(error)}`);
    }
    let conclusion: "success" | "failure";
    try {
      conclusion = await this.gateway.waitForRunConclusion(runId, grant.commitSha, PRODUCTION_DEPLOYMENT_TIMEOUT_MS);
    } catch (error) {
      throw new ProductionDeploymentError("production_reconciliation_failed", `run reconciliation failed: ${summarize(error)}`, { runId });
    }
    if (conclusion !== "success") {
      throw new ProductionDeploymentError("production_reconciliation_failed", "production deployment run failed", { runId });
    }
    await this.assertSmoke(this.policy.smokeUrl, runId, "production_smoke_failed");
    return Object.freeze({
      deploymentId: `production-${runId}`,
      runId,
      artifactCommitSha: grant.commitSha,
      smokeUrl: this.policy.smokeUrl,
      smokePassed: true as const,
      authorizedBy: grant.authorizedBy,
      reason: grant.reason
    });
  }

  /**
   * Reconciles a lost deployment response: given the artifact SHA, asks the gateway
   * whether a run for that SHA already exists; if it succeeded and smoke passes,
   * returns the same receipt shape without dispatching anything new.
   */
  async reconcileLostResponse(grant: ProductionGrant, findRunForSha: (sha: string) => Promise<string | null>): Promise<ProductionDeploymentReceipt | null> {
    assertProductionGrant(grant);
    const existingRunId = await findRunForSha(grant.commitSha);
    if (!existingRunId) return null;
    let conclusion: "success" | "failure";
    try {
      conclusion = await this.gateway.waitForRunConclusion(existingRunId, grant.commitSha, PRODUCTION_DEPLOYMENT_TIMEOUT_MS);
    } catch {
      return null;
    }
    if (conclusion !== "success") return null;
    await this.assertSmoke(this.policy.smokeUrl, existingRunId, "production_smoke_failed");
    return Object.freeze({
      deploymentId: `production-${existingRunId}`,
      runId: existingRunId,
      artifactCommitSha: grant.commitSha,
      smokeUrl: this.policy.smokeUrl,
      smokePassed: true as const,
      authorizedBy: grant.authorizedBy,
      reason: grant.reason
    });
  }

  /**
   * Verified rollback: rolls production back to a previous artifact by dispatching
   * the same workflow pinned to the rollback SHA (the workflow deploys whatever the
   * ref contains; the caller must ensure the ref points at the rollback commit).
   * The rollback is only confirmed after the run succeeds and smoke passes.
   */
  async rollback(fromCommitSha: string, rollbackGrant: ProductionGrant): Promise<ProductionRollbackReceipt> {
    if (!/^[0-9a-f]{40}$/.test(fromCommitSha)) {
      throw new ProductionDeploymentError("rollback_invalid_input", "fromCommitSha must be an exact lowercase Git SHA-1");
    }
    assertProductionGrant(rollbackGrant);
    if (rollbackGrant.commitSha === fromCommitSha) {
      throw new ProductionDeploymentError("rollback_not_authorized", "rollback target must differ from the current artifact");
    }
    let runId: string;
    try {
      runId = await this.gateway.dispatchWorkflow(this.policy.target, rollbackGrant.commitSha);
    } catch (error) {
      throw new ProductionDeploymentError("rollback_reconciliation_failed", `rollback dispatch failed: ${summarize(error)}`);
    }
    let conclusion: "success" | "failure";
    try {
      conclusion = await this.gateway.waitForRunConclusion(runId, rollbackGrant.commitSha, PRODUCTION_DEPLOYMENT_TIMEOUT_MS);
    } catch (error) {
      throw new ProductionDeploymentError("rollback_reconciliation_failed", `rollback reconciliation failed: ${summarize(error)}`, { runId });
    }
    if (conclusion !== "success") {
      throw new ProductionDeploymentError("rollback_reconciliation_failed", "rollback run failed", { runId });
    }
    await this.assertSmoke(this.policy.smokeUrl, runId, "rollback_smoke_failed");
    return Object.freeze({
      rollbackId: `rollback-${runId}`,
      runId,
      fromCommitSha,
      toCommitSha: rollbackGrant.commitSha,
      smokeUrl: this.policy.smokeUrl,
      smokePassed: true as const
    });
  }

  private async assertSmoke(smokeUrl: string, runId: string, code: ProductionDeploymentErrorCode): Promise<void> {
    let body: string;
    try {
      body = await this.gateway.fetchText(smokeUrl, 30_000);
    } catch (error) {
      throw new ProductionDeploymentError(code, `smoke probe failed: ${summarize(error)}`, { runId });
    }
    if (body.length > 1_048_576) body = body.slice(0, 1_048_576);
    if (!body.includes(this.policy.smokeExpectSubstring)) {
      throw new ProductionDeploymentError(code, "smoke response does not contain the expected substring", { runId });
    }
  }
}

function summarize(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? message.slice(-500) : message;
}
