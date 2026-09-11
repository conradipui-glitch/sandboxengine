// B13.b2 — single preview deployment adapter with artifact identity and smoke.
// One deployment path only: dispatch a fixed, policy-named GitHub Actions workflow
// on a fixed ref and reconcile its run against the exact artifact SHA. This module
// holds no Cloudflare credentials; authentication stays with the CI environment.

// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { execFile } from "node:child_process";
// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { promisify } from "node:util";
import type { BuilderWorkspacePolicy } from "./workspace-policy.js";
import type { CiStatusSource } from "./changeset-operations.js";

declare const process: any;

const execFileAsync = promisify(execFile);

export type PreviewDeploymentErrorCode =
  | "deployment_not_authorized"
  | "deployment_invalid_input"
  | "dispatch_failed"
  | "deployment_reconciliation_failed"
  | "smoke_failed";

export class PreviewDeploymentError extends Error {
  constructor(readonly code: PreviewDeploymentErrorCode, message: string, readonly details?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "PreviewDeploymentError";
  }
}

export interface PreviewDeploymentTarget {
  /** Exact GitHub repository hosting the deployment workflow ("owner/repo"). */
  readonly repositoryId: string;
  /** Workflow file name (e.g. "deploy-florence-preview.yml"); fixed per target. */
  readonly workflowFile: string;
  /** Branch/ref the workflow dispatches on; fixed per target. */
  readonly ref: string;
}

export interface PreviewDeploymentPolicyInput {
  readonly target: PreviewDeploymentTarget;
  /** Artifact identity required for a deploy: the exact commit SHA built and shipped. */
  readonly requiredCommitSha: string;
  /** HTTP URL that must answer the smoke probe after a successful run. */
  readonly smokeUrl: string;
  /** Bounded smoke expectations: substring that must appear in the response body. */
  readonly smokeExpectSubstring: string;
}

export interface PreviewDeploymentPolicy extends PreviewDeploymentPolicyInput {}

export function createPreviewDeploymentPolicy(input: PreviewDeploymentPolicyInput): PreviewDeploymentPolicy {
  const parts = input.target.repositoryId.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new PreviewDeploymentError("deployment_invalid_input", "target repositoryId must be owner/repo");
  }
  if (!/^[\w.-]+\.ya?ml$/.test(input.target.workflowFile)) {
    throw new PreviewDeploymentError("deployment_invalid_input", "workflowFile must be a bounded workflow file name");
  }
  if (!/^[\w./-]{1,200}$/.test(input.target.ref) || input.target.ref.includes("..")) {
    throw new PreviewDeploymentError("deployment_invalid_input", "ref is invalid");
  }
  if (!/^[0-9a-f]{40}$/.test(input.requiredCommitSha)) {
    throw new PreviewDeploymentError("deployment_invalid_input", "requiredCommitSha must be an exact lowercase Git SHA-1");
  }
  let smokeUrl: URL;
  try {
    smokeUrl = new URL(input.smokeUrl);
  } catch {
    throw new PreviewDeploymentError("deployment_invalid_input", "smokeUrl must be an absolute URL");
  }
  if (smokeUrl.protocol !== "https:" && smokeUrl.protocol !== "http:") {
    throw new PreviewDeploymentError("deployment_invalid_input", "smokeUrl must be http(s)");
  }
  if (typeof input.smokeExpectSubstring !== "string" || input.smokeExpectSubstring.length === 0 || input.smokeExpectSubstring.length > 200) {
    throw new PreviewDeploymentError("deployment_invalid_input", "smokeExpectSubstring must be a bounded non-empty string");
  }
  return Object.freeze({ ...input });
}

/** Environment-provided deployment operations; implemented with `gh` per environment. */
export interface PreviewDeploymentGateway {
  /**
   * The repository this gateway is authorized to act on ("owner/repo"). When present, a
   * policy targeting any other repository is refused before dispatch.
   */
  readonly repositoryId?: string;
  dispatchWorkflow(target: PreviewDeploymentTarget, commitSha: string): Promise<string>;
  waitForRunConclusion(runId: string, commitSha: string, timeoutMs: number): Promise<"success" | "failure">;
  fetchText(url: string, timeoutMs: number): Promise<string>;
}

export interface PreviewDeploymentReceipt {
  readonly deploymentId: string;
  readonly runId: string;
  readonly artifactCommitSha: string;
  readonly smokeUrl: string;
  readonly smokePassed: true;
}

const MAX_SMOKE_BYTES = 1_048_576;

export class PreviewDeploymentAdapter {
  constructor(
    private readonly policy: PreviewDeploymentPolicy,
    private readonly gateway: PreviewDeploymentGateway
  ) {
    // A dead tautology lived here (`policy.target.repositoryId !== policy.target.repositoryId`
    // is never true), so an adapter happily accepted any hand-assembled target. The target is
    // re-validated through the one authorized factory and the gateway must be bound to the very
    // repository the target names: a policy pointing at another repository can no longer be
    // dispatched, because the run lookup would otherwise reconcile a different repository's run.
    createPreviewDeploymentPolicy(policy);
    if (gateway.repositoryId !== undefined && gateway.repositoryId !== policy.target.repositoryId) {
      throw new PreviewDeploymentError("deployment_not_authorized", "target repository is not the authorized one");
    }
  }

  /**
   * Reconciles a lost deployment response without dispatching: resolves an existing
   * successful run for the required commit SHA through the gateway's run lookup and
   * confirms it with smoke. Returns the same receipt a deploy would produce.
   */
  async reconcileLostResponse(
    findRunForSha: (sha: string) => Promise<string | null>
  ): Promise<PreviewDeploymentReceipt | null> {
    const existingRunId = await findRunForSha(this.policy.requiredCommitSha);
    if (!existingRunId) return null;
    let conclusion: "success" | "failure";
    try {
      conclusion = await this.gateway.waitForRunConclusion(existingRunId, this.policy.requiredCommitSha, 300_000);
    } catch {
      return null;
    }
    if (conclusion !== "success") return null;
    let body: string;
    try {
      body = await this.gateway.fetchText(this.policy.smokeUrl, 30_000);
    } catch {
      throw new PreviewDeploymentError("smoke_failed", "smoke probe failed during reconciliation", { runId: existingRunId });
    }
    if (body.length > MAX_SMOKE_BYTES) body = body.slice(0, MAX_SMOKE_BYTES);
    if (!body.includes(this.policy.smokeExpectSubstring)) {
      throw new PreviewDeploymentError("smoke_failed", "smoke response does not contain the expected substring", { runId: existingRunId });
    }
    return Object.freeze({
      deploymentId: `preview-${existingRunId}`,
      runId: existingRunId,
      artifactCommitSha: this.policy.requiredCommitSha,
      smokeUrl: this.policy.smokeUrl,
      smokePassed: true as const
    });
  }

  /** Dispatches the fixed preview workflow pinned to the required commit SHA. */
  async deploy(policy2?: PreviewDeploymentPolicy): Promise<PreviewDeploymentReceipt> {
    const active = policy2 ?? this.policy;
    if (active.requiredCommitSha !== this.policy.requiredCommitSha) {
      throw new PreviewDeploymentError("deployment_not_authorized", "artifact SHA differs from the authorized one");
    }
    let runId: string;
    try {
      runId = await this.gateway.dispatchWorkflow(this.policy.target, this.policy.requiredCommitSha);
    } catch (error) {
      throw new PreviewDeploymentError("dispatch_failed", `workflow dispatch failed: ${summarize(error)}`);
    }
    let conclusion: "success" | "failure";
    try {
      conclusion = await this.gateway.waitForRunConclusion(runId, this.policy.requiredCommitSha, 900_000);
    } catch (error) {
      throw new PreviewDeploymentError("deployment_reconciliation_failed", `run reconciliation failed: ${summarize(error)}`, { runId });
    }
    if (conclusion !== "success") {
      throw new PreviewDeploymentError("deployment_reconciliation_failed", "preview deployment run failed", { runId });
    }
    let body: string;
    try {
      body = await this.gateway.fetchText(this.policy.smokeUrl, 30_000);
    } catch (error) {
      throw new PreviewDeploymentError("smoke_failed", `smoke probe failed: ${summarize(error)}`, { runId });
    }
    if (body.length > MAX_SMOKE_BYTES) body = body.slice(0, MAX_SMOKE_BYTES);
    if (!body.includes(this.policy.smokeExpectSubstring)) {
      throw new PreviewDeploymentError("smoke_failed", "smoke response does not contain the expected substring", { runId });
    }
    return Object.freeze({
      deploymentId: `preview-${runId}`,
      runId,
      artifactCommitSha: this.policy.requiredCommitSha,
      smokeUrl: this.policy.smokeUrl,
      smokePassed: true as const
    });
  }
}

/** gh-CLI gateway used outside unit tests. Fixed argv, no shell, bounded timeout. */
export function createGhPreviewDeploymentGateway(repositoryId: string): PreviewDeploymentGateway {
  async function gh(args: readonly string[], timeoutMs: number): Promise<string> {
    try {
      const result = await execFileAsync("gh", [...args], {
        env: cleanEnvironment(),
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 1_048_576
      });
      return String(result.stdout ?? "");
    } catch (error: any) {
      if (error && error.killed) throw new Error("gh timed out");
      throw new Error(tail(String(error?.stderr ?? error?.message ?? "gh failed")));
    }
  }
  return Object.freeze({
    repositoryId,
    async dispatchWorkflow(target: PreviewDeploymentTarget, commitSha: string) {
      if (target.repositoryId !== repositoryId) {
        throw new Error("target repository is not the repository this gateway is authorized for");
      }
      // workflow_dispatch has no input to pin a SHA, so the adapter dispatches the
      // fixed ref and later reconciles headSha === requiredCommitSha; a ref move
      // between push and dispatch fails reconciliation instead of deploying drift.
      await gh(["workflow", "run", target.workflowFile, "--repo", target.repositoryId, "--ref", target.ref], 30_000);
      // Resolve the run created by this dispatch: newest run for the workflow on the ref.
      for (let attempt = 0; attempt < 20; attempt++) {
        await sleep(3_000);
        const list = await gh(["run", "list", "--repo", target.repositoryId, "--workflow", target.workflowFile, "--branch", target.ref, "--limit", "5", "--json", "databaseId,headSha,status"], 30_000);
        const runs = JSON.parse(list) as Array<{ databaseId: number; headSha: string; status: string }>;
        const candidate = runs.find((run) => run.headSha === commitSha && run.status !== "completed");
        if (candidate) return String(candidate.databaseId);
        if (runs.some((run) => run.headSha === commitSha && run.status === "completed")) {
          const done = runs.find((run) => run.headSha === commitSha) as { databaseId: number };
          return String(done.databaseId);
        }
      }
      throw new Error("dispatched run was not observed for the required commit");
    },
    async waitForRunConclusion(runId: string, commitSha: string, timeoutMs: number) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const view = await gh(["run", "view", runId, "--repo", repositoryId, "--json", "status,conclusion,headSha"], 30_000);
        const parsed = JSON.parse(view) as { status: string; conclusion: string | null; headSha: string };
        if (parsed.headSha !== commitSha) throw new Error("run head SHA drifted from the required artifact");
        if (parsed.status === "completed") {
          if (parsed.conclusion === "success") return "success";
          return "failure";
        }
        await sleep(15_000);
      }
      throw new Error("run did not conclude before the timeout");
    },
    async fetchText(url: string, timeoutMs: number) {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`smoke HTTP ${response.status}`);
      return response.text();
    }
  });
}

function cleanEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "GH_TOKEN", "GITHUB_TOKEN", "XDG_CONFIG_HOME", "APPDATA", "LOCALAPPDATA", "HOME", "USERPROFILE"]) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) environment[key] = value;
  }
  return environment;
}

function summarize(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return tail(message);
}

function tail(value: string): string {
  return value.length > 500 ? value.slice(-500) : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
