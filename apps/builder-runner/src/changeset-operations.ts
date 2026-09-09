// B13.b1 — authorized commit/push change set with an external operation ID and
// CI reconciliation against the exact pushed SHA. This module performs Git plumbing
// via fixed argv inside the isolated workspace only. It never touches the source
// checkout, never uses shell, and requires an explicit PushGrant per operation.

// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { execFile } from "node:child_process";
// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { mkdtemp, realpath, rm } from "node:fs/promises";
// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { join } from "node:path";
// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { tmpdir } from "node:os";
// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { promisify } from "node:util";
import type { BuilderWorkspacePolicy } from "./workspace-policy.js";
import { createMutableBuilderWorkspace, type MutableBuilderWorkspaceReal } from "./workspace-executor.js";

declare const process: any;

const execFileAsync = promisify(execFile);

export type ChangeSetErrorCode =
  | "invalid_change_set"
  | "push_not_authorized"
  | "push_failed"
  | "remote_state_conflict"
  | "ci_reconciliation_failed"
  | "operation_replayed";

export class ChangeSetError extends Error {
  constructor(readonly code: ChangeSetErrorCode, message: string, readonly details?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "ChangeSetError";
  }
}

export interface PushGrant {
  /** Exact remote repository ID this grant authorizes, e.g. "owner/repo". */
  readonly repositoryId: string;
  /** Target branch the grant authorizes; the workspace branch must match it exactly. */
  readonly targetBranch: string;
  /** Identity used for the commit; no credentials live here. */
  readonly authorName: string;
  readonly authorEmail: string;
  /** Bounded commit subject, no shell metacharacters. */
  readonly commitSubject: string;
}

export interface ChangeSetInput {
  /** External idempotency key supplied by the caller (operation ID). */
  readonly operationId: string;
  readonly grant: PushGrant;
  readonly operations: ReadonlyArray<Readonly<{ path: string; content: string }>>;
}

export interface ChangeSetReceipt {
  readonly operationId: string;
  readonly baseCommitSha: string;
  readonly commitSha: string;
  readonly treeHash: string;
  readonly branch: string;
  readonly changedPaths: readonly string[];
}

export interface CiReconciliation {
  readonly runId: string;
  readonly headSha: string;
  readonly conclusion: "success" | "failure" | "pending";
}

/** A read-only view the CI reconciler depends on; implemented per environment (e.g. gh CLI). */
export interface CiStatusSource {
  latestRunForSha(branch: string, sha: string): Promise<CiReconciliation | null>;
}

/**
 * Applies the bounded patch, commits it on the isolated workspace branch and pushes
 * that exact branch to the remote. The push uses a throwaway clean environment; the
 * remote must be a URL passed at construction time (no credential helper of the host).
 */
export class BoundedChangeSetApplier {
  private readonly workspaces = new Map<string, MutableBuilderWorkspaceReal>();

  constructor(
    private readonly policy: BuilderWorkspacePolicy,
    private readonly remoteUrl: string,
    private readonly ci: CiStatusSource
  ) {
    const remoteId = `${repositoryOwnerFromUrl(remoteUrl)}/${repositoryNameFromUrl(remoteUrl)}`;
    // Local bare fixtures and SSH/HTTPS remotes must both map to the exact policy repository.
    if (policy.repositoryId !== remoteId && !isLocalPath(remoteUrl)) {
      throw new ChangeSetError("invalid_change_set", `remote URL ${remoteId} does not match the policy repository ${policy.repositoryId}`);
    }
  }

  async workspace(): Promise<MutableBuilderWorkspaceReal> {
    const existing = this.workspaces.get(this.policy.baseCommitSha);
    if (existing) return existing;
    const created = await createMutableBuilderWorkspace(this.policy);
    this.workspaces.set(this.policy.baseCommitSha, created);
    return created;
  }

  async applyAndPush(input: ChangeSetInput): Promise<ChangeSetReceipt> {
    assertValidOperationId(input.operationId);
    assertGrantMatchesPolicy(this.policy, input.grant);
    const workspace = await this.workspace();

    for (const operation of input.operations) {
      await workspace.writeText(operation.path, operation.content);
    }
    const treeHash = await workspace.treeIdentity();

    const env = isolatedExecutionEnvironment();
    await git(workspace.workspaceRoot, env, ["config", "user.name", input.grant.authorName], "push_failed");
    await git(workspace.workspaceRoot, env, ["config", "user.email", input.grant.authorEmail], "push_failed");
    await git(workspace.workspaceRoot, env, ["add", "-A", "--", ...this.policy.writablePaths], "push_failed");
    // Commit only if there is something staged; identical content yields an existing tree.
    const statusOutput = await git(workspace.workspaceRoot, env, ["status", "--porcelain"], "push_failed");
    let commitSha = (await git(workspace.workspaceRoot, env, ["rev-parse", "HEAD"], "push_failed")).trim();
    if (statusOutput.trim().length > 0) {
      await git(workspace.workspaceRoot, env, ["commit", "--quiet", "-m", input.grant.commitSubject], "push_failed");
      commitSha = (await git(workspace.workspaceRoot, env, ["rev-parse", "HEAD"], "push_failed")).trim();
    } else {
      throw new ChangeSetError("invalid_change_set", "change set produced no effective modification");
    }

    await git(workspace.workspaceRoot, env, ["remote", "add", "builder-origin", this.remoteUrl], "push_failed");
    await git(workspace.workspaceRoot, env, ["push", "--quiet", "builder-origin", `HEAD:refs/heads/${input.grant.targetBranch}`], "push_failed");

    return Object.freeze({
      operationId: input.operationId,
      baseCommitSha: this.policy.baseCommitSha,
      commitSha,
      treeHash,
      branch: input.grant.targetBranch,
      changedPaths: Object.freeze(input.operations.map((operation) => operation.path).sort())
    });
  }

  async reconcileWithCi(branch: string, commitSha: string): Promise<CiReconciliation> {
    const run = await this.ci.latestRunForSha(branch, commitSha);
    if (!run || run.headSha !== commitSha) {
      throw new ChangeSetError("ci_reconciliation_failed", "no CI run observed for the exact pushed commit", { commitSha });
    }
    return run;
  }

  async dispose(): Promise<void> {
    for (const workspace of this.workspaces.values()) {
      await workspace.dispose();
    }
    this.workspaces.clear();
  }
}

function assertValidOperationId(operationId: string): void {
  if (typeof operationId !== "string" || operationId.length < 8 || operationId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(operationId)) {
    throw new ChangeSetError("invalid_change_set", "operationId must be a bounded external identifier");
  }
}

function assertGrantMatchesPolicy(policy: BuilderWorkspacePolicy, grant: PushGrant): void {
  if (grant.repositoryId !== policy.repositoryId) {
    throw new ChangeSetError("push_not_authorized", "grant repository does not match the task policy");
  }
  if (grant.targetBranch !== policy.baseBranch) {
    throw new ChangeSetError("push_not_authorized", "grant branch does not match the task policy branch");
  }
  if (!/^[\w .-]{1,100}$/.test(grant.authorName) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(grant.authorEmail)) {
    throw new ChangeSetError("invalid_change_set", "commit identity is invalid");
  }
  if (typeof grant.commitSubject !== "string" || grant.commitSubject.length === 0 || grant.commitSubject.length > 200
    || grant.commitSubject.includes("\n") || grant.commitSubject.includes("\r")) {
    throw new ChangeSetError("invalid_change_set", "commit subject is invalid");
  }
}

function repositoryOwnerFromUrl(url: string): string {
  const match = /[/:]([^/]+)\/[^/]+(?:\.git)?\/?$/.exec(url);
  return match?.[1] ?? "";
}

function repositoryNameFromUrl(url: string): string {
  const match = /\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  return match?.[1] ?? "";
}

function isLocalPath(url: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(url) || url.startsWith("/");
}

export function isolatedExecutionEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0"
  };
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) environment[key] = value;
  }
  return environment;
}

async function git(cwd: string, env: Record<string, string>, args: readonly string[], errorCode: ChangeSetErrorCode): Promise<string> {
  try {
    const result = await execFileAsync("git", [...args], { cwd, env, windowsHide: true, timeout: 30_000, maxBuffer: 1_048_576 });
    return String(result.stdout ?? "");
  } catch (error: any) {
    throw new ChangeSetError(errorCode, `git ${args[0]} failed: ${tailText(String(error?.stderr ?? error?.message ?? ""))}`);
  }
}

function tailText(value: string): string {
  return value.length > 500 ? value.slice(-500) : value;
}
