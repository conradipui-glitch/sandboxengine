// B13.a2 — bounded agent job orchestration.
// Keeps mutation, verification and external operations separate.

import { applyBoundedPatch, type MutableBuilderWorkspace, type PatchEvidence, type PatchOperation } from "./bounded-patch-job.js";
import type { BuilderWorkspacePolicy } from "./workspace-policy.js";

export interface BuilderVerificationRunner {
  run(executable: string, args: readonly string[]): Promise<void>;
}

export interface BoundedAgentJobResult {
  readonly patch: PatchEvidence;
  readonly verifiedCommands: readonly string[];
}

export async function runBoundedAgentJob(
  workspace: MutableBuilderWorkspace,
  policy: BuilderWorkspacePolicy,
  operations: readonly PatchOperation[],
  verifier: BuilderVerificationRunner
): Promise<BoundedAgentJobResult> {
  const patch = await applyBoundedPatch(workspace, policy, operations);

  const verifiedCommands: string[] = [];
  for (const command of policy.verificationCommands) {
    await verifier.run(command.executable, command.args);
    verifiedCommands.push([command.executable, ...command.args].join(" "));
  }

  return Object.freeze({
    patch,
    verifiedCommands: Object.freeze(verifiedCommands)
  });
}
