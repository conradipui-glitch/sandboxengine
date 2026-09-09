// B13.a2 — bounded patch job
// This module deliberately stops at isolated workspace mutation/evidence.
// It does not push, create PRs, start workflows or deploy.

import { createHash } from "node:crypto";
import { authorizeBuilderPath, type BuilderWorkspacePolicy } from "./workspace-policy.js";

export type PatchOperation = Readonly<{
  path: string;
  content: string;
}>;

export type PatchEvidence = Readonly<{
  baseCommitSha: string;
  changedPaths: readonly string[];
  diffHash: string;
  treeHash: string;
}>;

export class BoundedPatchError extends Error {
  constructor(readonly code: "path_not_allowed" | "empty_patch" | "tree_mismatch", message: string) {
    super(message);
    this.name = "BoundedPatchError";
  }
}

export interface MutableBuilderWorkspace {
  readonly baseCommitSha: string;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  treeIdentity(): Promise<string>;
}

export async function applyBoundedPatch(
  workspace: MutableBuilderWorkspace,
  policy: BuilderWorkspacePolicy,
  operations: readonly PatchOperation[]
): Promise<PatchEvidence> {
  if (operations.length === 0) {
    throw new BoundedPatchError("empty_patch", "patch must contain at least one operation");
  }

  const normalized = operations.map((operation) => ({
    path: authorizeBuilderPath(policy, operation.path, "write"),
    content: operation.content
  }));

  for (const operation of normalized) {
    await workspace.writeText(operation.path, operation.content);
  }

  const changedPaths = Object.freeze(normalized.map((operation) => operation.path).sort());
  const diffHash = hash(JSON.stringify(normalized));
  const treeHash = await workspace.treeIdentity();

  if (workspace.baseCommitSha !== policy.baseCommitSha) {
    throw new BoundedPatchError("tree_mismatch", "workspace base commit changed during patch");
  }

  return Object.freeze({
    baseCommitSha: workspace.baseCommitSha,
    changedPaths,
    diffHash,
    treeHash
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
