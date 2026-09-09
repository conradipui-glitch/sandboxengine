// B13.a2 builder-runner public surface.
// Mutation, policy, workspace and executor modules remain explicit boundaries.

export { applyBoundedPatch, BoundedPatchError } from "./bounded-patch-job.js";
export type { MutableBuilderWorkspace, PatchEvidence, PatchOperation } from "./bounded-patch-job.js";

export { runBoundedAgentJob } from "./bounded-agent-job.js";
export type { BoundedAgentJobResult, BuilderVerificationRunner } from "./bounded-agent-job.js";

export { createBuilderWorkspacePolicy, authorizeBuilderPath } from "./workspace-policy.js";
export type { BuilderWorkspacePolicy } from "./workspace-policy.js";

export { createReadonlyBuilderWorkspace } from "./readonly-workspace.js";
export type { ReadonlyBuilderWorkspace } from "./readonly-workspace.js";

export { MutableWorkspaceError, createMutableBuilderWorkspace, createPolicyVerificationRunner } from "./workspace-executor.js";
export type { MutableBuilderWorkspaceReal, VerificationOutcome } from "./workspace-executor.js";

export { BoundedChangeSetApplier, ChangeSetError } from "./changeset-operations.js";
export type {
  ChangeSetInput, ChangeSetReceipt, CiReconciliation, CiStatusSource, PushGrant
} from "./changeset-operations.js";
