// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
import { createHash } from "node:crypto";
import { canonicalStringify } from "@living-history/core";
import type {
  AuthorAgentCheckpointFact,
  AuthorAgentJobRecord,
  AuthorAgentJobStore,
  AuthorAgentOperationKind
} from "./author-agent-jobs.js";

export const AUTHOR_TOOL_BROKER_POLICY_VERSION = "1.0";
export const AUTHOR_TOOL_IDS = Object.freeze([
  "author.draft.read",
  "author.proposal.preview",
  "author.proposal.apply",
  "docs.agent-kit.read",
  "docs.reference.read"
] as const);
export type AuthorToolId = (typeof AUTHOR_TOOL_IDS)[number];
export type AuthorToolSource = "builtin" | "skill" | "mcp";

interface TrustedAuthorToolDescriptor {
  readonly toolId: AuthorToolId;
  readonly operationKind: AuthorAgentOperationKind | null;
  readonly builtinFallback: boolean;
}

const TRUSTED_AUTHOR_TOOLS: readonly TrustedAuthorToolDescriptor[] = Object.freeze([
  Object.freeze({ toolId: "author.draft.read", operationKind: "draft.read", builtinFallback: true }),
  Object.freeze({ toolId: "author.proposal.preview", operationKind: "proposal.preview", builtinFallback: true }),
  Object.freeze({ toolId: "author.proposal.apply", operationKind: "proposal.apply", builtinFallback: true }),
  Object.freeze({ toolId: "docs.agent-kit.read", operationKind: null, builtinFallback: true }),
  Object.freeze({ toolId: "docs.reference.read", operationKind: null, builtinFallback: false })
]);

export const AUTHOR_TOOL_BROKER_POLICY_HASH = sha256(canonicalStringify({
  policyVersion: AUTHOR_TOOL_BROKER_POLICY_VERSION,
  defaultDeny: true,
  permissionsComeFromThirdPartyText: false,
  forbiddenAuthorityClasses: [
    "shell", "filesystem", "repository-mutation", "code-execution", "deployment", "secret-read"
  ],
  tools: TRUSTED_AUTHOR_TOOLS.map((tool) => ({
    toolId: tool.toolId,
    operationKind: tool.operationKind,
    builtinFallback: tool.builtinFallback
  }))
}));

export interface AuthorToolBrokerPin {
  readonly jobId: string;
  readonly projectId: string;
  readonly questId: string;
  readonly policyVersion: string;
  readonly policyHash: string;
  readonly installedDocsHash: string;
  readonly contractHash: string;
  readonly allowedToolIds: readonly AuthorToolId[];
}

export type BuildAuthorToolBrokerPinResult =
  | { readonly kind: "built"; readonly pin: AuthorToolBrokerPin }
  | { readonly kind: "invalid_request" };

export type EnsureAuthorToolBrokerPinResult =
  | { readonly kind: "pinned"; readonly job: AuthorAgentJobRecord; readonly pin: AuthorToolBrokerPin; readonly newlyPinned: boolean }
  | { readonly kind: "pinned_mismatch"; readonly job: AuthorAgentJobRecord; readonly pin: AuthorToolBrokerPin; readonly currentPin: AuthorToolBrokerPin }
  | { readonly kind: "invalid_pin"; readonly job: AuthorAgentJobRecord }
  | { readonly kind: "job_not_found" }
  | { readonly kind: "job_conflict"; readonly currentJobVersion: number }
  | { readonly kind: "invalid_request" };

export interface AuthorToolBrokerRequest {
  readonly toolId: string;
  readonly source: AuthorToolSource;
  readonly transportAvailable?: boolean;
}

export type AuthorToolBrokerDecision =
  | {
      readonly kind: "allowed";
      readonly toolId: AuthorToolId;
      readonly source: AuthorToolSource;
      readonly operationKind: AuthorAgentOperationKind | null;
    }
  | {
      readonly kind: "denied";
      readonly code: "invalid_request" | "tool_not_allowed" | "job_grant_required" | "contract_mismatch" | "contract_stale";
      readonly requestedToolId: string;
    }
  | {
      readonly kind: "unavailable";
      readonly code: "mcp_unavailable";
      readonly toolId: AuthorToolId;
      readonly fallback: { readonly source: "builtin"; readonly toolId: AuthorToolId } | null;
    };

export function buildAuthorToolBrokerPin(
  job: AuthorAgentJobRecord,
  installedDocsHash: string
): BuildAuthorToolBrokerPinResult {
  if (!isHash(installedDocsHash) || !job || typeof job !== "object") return frozen({ kind: "invalid_request" });
  const allowed = new Set<AuthorToolId>(["docs.agent-kit.read", "docs.reference.read"]);
  for (const operationKind of job.grant.allowedOperations) {
    const toolId = toolIdForOperation(operationKind);
    if (toolId === null) return frozen({ kind: "invalid_request" });
    allowed.add(toolId);
  }
  const allowedToolIds = Object.freeze([...allowed].sort()) as readonly AuthorToolId[];
  const base = {
    jobId: job.jobId,
    projectId: job.projectId,
    questId: job.questId,
    policyVersion: AUTHOR_TOOL_BROKER_POLICY_VERSION,
    policyHash: AUTHOR_TOOL_BROKER_POLICY_HASH,
    installedDocsHash,
    allowedToolIds
  };
  const pin = deepFreeze({ ...base, contractHash: contractHash(base) });
  return frozen({ kind: "built", pin });
}

export async function ensureAuthorToolBrokerPin(
  jobs: AuthorAgentJobStore,
  job: AuthorAgentJobRecord,
  installedDocsHash: string,
  atMs: number
): Promise<EnsureAuthorToolBrokerPinResult> {
  if (!Number.isSafeInteger(atMs) || atMs < 0) return frozen({ kind: "invalid_request" });
  const built = buildAuthorToolBrokerPin(job, installedDocsHash);
  if (built.kind !== "built") return built;
  const checkpoints = await jobs.listCheckpoints(job.jobId);
  if (checkpoints === null) return frozen({ kind: "job_not_found" });
  const pinnedFacts = checkpoints.filter((entry) => entry.fact.kind === "broker.pinned");
  if (pinnedFacts.length > 1) return frozen({ kind: "invalid_pin", job });
  if (pinnedFacts.length === 1) {
    const fact = pinnedFacts[0]!.fact;
    if (fact.kind !== "broker.pinned") return frozen({ kind: "invalid_pin", job });
    const pin = pinFromFact(job, fact);
    if (pin === null) return frozen({ kind: "invalid_pin", job });
    if (!samePin(pin, built.pin)) {
      return frozen({ kind: "pinned_mismatch", job, pin, currentPin: built.pin });
    }
    return frozen({ kind: "pinned", job, pin, newlyPinned: false });
  }

  const appended = await jobs.appendCheckpoint(job.jobId, job.jobVersion, pinFact(built.pin), atMs);
  if (appended.kind === "updated") {
    return frozen({ kind: "pinned", job: appended.job, pin: built.pin, newlyPinned: true });
  }
  if (appended.kind === "job_not_found") return frozen({ kind: "job_not_found" });
  if (appended.kind === "job_version_conflict") {
    return frozen({ kind: "job_conflict", currentJobVersion: appended.currentJobVersion });
  }
  return frozen({ kind: "invalid_request" });
}

export function authorizeAuthorToolBrokerRequest(
  pin: AuthorToolBrokerPin,
  job: AuthorAgentJobRecord,
  request: AuthorToolBrokerRequest
): AuthorToolBrokerDecision {
  if (!isSource(request.source) || typeof request.toolId !== "string" || request.toolId.length < 1 || request.toolId.length > 200) {
    return frozen({ kind: "denied", code: "invalid_request", requestedToolId: String(request.toolId ?? "") });
  }
  const descriptor = trustedTool(request.toolId);
  if (descriptor === null) return frozen({ kind: "denied", code: "tool_not_allowed", requestedToolId: request.toolId });
  if (pin.jobId !== job.jobId || pin.projectId !== job.projectId || pin.questId !== job.questId
    || pin.contractHash !== contractHash(pin)) {
    return frozen({ kind: "denied", code: "contract_mismatch", requestedToolId: request.toolId });
  }
  if (pin.policyVersion !== AUTHOR_TOOL_BROKER_POLICY_VERSION || pin.policyHash !== AUTHOR_TOOL_BROKER_POLICY_HASH) {
    return frozen({ kind: "denied", code: "contract_stale", requestedToolId: request.toolId });
  }
  if (!pin.allowedToolIds.includes(descriptor.toolId)) {
    return frozen({ kind: "denied", code: "job_grant_required", requestedToolId: request.toolId });
  }
  if (descriptor.operationKind !== null && !job.grant.allowedOperations.includes(descriptor.operationKind)) {
    return frozen({ kind: "denied", code: "job_grant_required", requestedToolId: request.toolId });
  }
  if (request.source === "mcp" && request.transportAvailable !== true) {
    return deepFreeze({
      kind: "unavailable" as const,
      code: "mcp_unavailable" as const,
      toolId: descriptor.toolId,
      fallback: descriptor.builtinFallback ? { source: "builtin" as const, toolId: descriptor.toolId } : null
    });
  }
  return frozen({
    kind: "allowed",
    toolId: descriptor.toolId,
    source: request.source,
    operationKind: descriptor.operationKind
  });
}

function pinFact(pin: AuthorToolBrokerPin): Extract<AuthorAgentCheckpointFact, { kind: "broker.pinned" }> {
  return deepFreeze({
    kind: "broker.pinned" as const,
    policyVersion: pin.policyVersion,
    policyHash: pin.policyHash,
    installedDocsHash: pin.installedDocsHash,
    contractHash: pin.contractHash,
    allowedToolIds: [...pin.allowedToolIds]
  });
}

function pinFromFact(
  job: AuthorAgentJobRecord,
  fact: Extract<AuthorAgentCheckpointFact, { kind: "broker.pinned" }>
): AuthorToolBrokerPin | null {
  if (!isHash(fact.policyHash) || !isHash(fact.installedDocsHash) || !isHash(fact.contractHash)
    || !Array.isArray(fact.allowedToolIds) || fact.allowedToolIds.length < 1 || fact.allowedToolIds.length > 16
    || !fact.allowedToolIds.every((toolId) => typeof toolId === "string" && isId(toolId))) return null;
  const pin = deepFreeze({
    jobId: job.jobId,
    projectId: job.projectId,
    questId: job.questId,
    policyVersion: fact.policyVersion,
    policyHash: fact.policyHash,
    installedDocsHash: fact.installedDocsHash,
    contractHash: fact.contractHash,
    allowedToolIds: [...fact.allowedToolIds] as AuthorToolId[]
  });
  return pin.contractHash === contractHash(pin) ? pin : null;
}

function samePin(left: AuthorToolBrokerPin, right: AuthorToolBrokerPin): boolean {
  return left.jobId === right.jobId && left.projectId === right.projectId && left.questId === right.questId
    && left.policyVersion === right.policyVersion && left.policyHash === right.policyHash
    && left.installedDocsHash === right.installedDocsHash && left.contractHash === right.contractHash
    && left.allowedToolIds.length === right.allowedToolIds.length
    && left.allowedToolIds.every((toolId, index) => toolId === right.allowedToolIds[index]);
}

function contractHash(value: Omit<AuthorToolBrokerPin, "contractHash"> | AuthorToolBrokerPin): string {
  return sha256(canonicalStringify({
    jobId: value.jobId,
    projectId: value.projectId,
    questId: value.questId,
    policyVersion: value.policyVersion,
    policyHash: value.policyHash,
    installedDocsHash: value.installedDocsHash,
    allowedToolIds: [...value.allowedToolIds]
  }));
}

function trustedTool(toolId: string): TrustedAuthorToolDescriptor | null {
  return TRUSTED_AUTHOR_TOOLS.find((candidate) => candidate.toolId === toolId) ?? null;
}

function toolIdForOperation(operationKind: AuthorAgentOperationKind): AuthorToolId | null {
  if (operationKind === "draft.read") return "author.draft.read";
  if (operationKind === "proposal.preview") return "author.proposal.preview";
  if (operationKind === "proposal.apply") return "author.proposal.apply";
  return null;
}

function isSource(value: unknown): value is AuthorToolSource {
  return value === "builtin" || value === "skill" || value === "mcp";
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function frozen<const T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
