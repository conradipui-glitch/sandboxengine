// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
import { createHash } from "node:crypto";
import {
  authorizeAuthorToolBrokerRequest,
  ensureAuthorToolBrokerPin,
  type AuthorAgentJobRecord,
  type AuthorAgentJobStore,
  type AuthorAgentOperationRecord,
  type AuthorAgentOperationResult
} from "@living-history/control";
import { canonicalStringify } from "@living-history/core";
import { loadInstalledAgentKit } from "./agent-kit.js";
import {
  DEFAULT_AUTHOR_MCP_TIMEOUT_MS,
  MAX_AUTHOR_MCP_QUERY_CHARS,
  MAX_AUTHOR_MCP_TIMEOUT_MS,
  invokeAuthorMcpReferenceRead,
  type AuthorMcpClient
} from "./author-mcp.js";

export interface AuthorReferenceToolBridgeSafeView {
  readonly toolIds: readonly ["docs.reference.read"];
  readonly shell: false;
  readonly filesystem: false;
  readonly repositoryMutation: false;
  readonly codeExecution: false;
  readonly deployment: false;
  readonly secretRead: false;
}

export interface AuthorReferenceToolBridgeInput {
  readonly operationId: string;
  readonly query: string;
  readonly targetVersion: string | null;
  readonly timeoutMs?: number;
}

export type AuthorReferenceToolBridgeResult =
  | {
      readonly kind: "completed";
      readonly job: AuthorAgentJobRecord;
      readonly replay: boolean;
      readonly connectionId: string;
      readonly serverId: string;
      readonly version: string;
      readonly output: unknown;
    }
  | {
      readonly kind: "unavailable";
      readonly job: AuthorAgentJobRecord;
      readonly replay: boolean;
      readonly code: "mcp_offline" | "mcp_timeout" | "mcp_transport_error";
    }
  | { readonly kind: "invalid_response"; readonly job: AuthorAgentJobRecord; readonly replay: boolean }
  | { readonly kind: "pending"; readonly job: AuthorAgentJobRecord }
  | { readonly kind: "paused_budget"; readonly job: AuthorAgentJobRecord }
  | {
      readonly kind: "denied";
      readonly code: "invalid_request" | "job_not_found" | "job_conflict" | "job_not_runnable" | "operation_id_reused" | "broker_denied";
      readonly job?: AuthorAgentJobRecord;
    };

export interface AuthorReferenceToolBridge {
  readonly safeView: AuthorReferenceToolBridgeSafeView;
  readReference(input: AuthorReferenceToolBridgeInput): Promise<AuthorReferenceToolBridgeResult>;
}

export interface AuthorReferenceToolBridgeDependencies {
  readonly jobs: AuthorAgentJobStore;
  readonly client: AuthorMcpClient;
  readonly nowMs?: () => number;
}

const SAFE_VIEW: AuthorReferenceToolBridgeSafeView = deepFreeze({
  toolIds: ["docs.reference.read"] as const,
  shell: false,
  filesystem: false,
  repositoryMutation: false,
  codeExecution: false,
  deployment: false,
  secretRead: false
});

export function createAuthorReferenceToolBridge(
  dependencies: AuthorReferenceToolBridgeDependencies,
  jobId: string
): AuthorReferenceToolBridge {
  return Object.freeze({
    safeView: SAFE_VIEW,
    readReference: (input: AuthorReferenceToolBridgeInput) => invokeBrokeredAuthorReferenceRead(dependencies, jobId, input)
  });
}

export async function invokeBrokeredAuthorReferenceRead(
  dependencies: AuthorReferenceToolBridgeDependencies,
  jobId: string,
  input: AuthorReferenceToolBridgeInput
): Promise<AuthorReferenceToolBridgeResult> {
  if (!isId(jobId) || !isInput(input)) return frozen({ kind: "denied", code: "invalid_request" });
  const atMs = now(dependencies);
  if (atMs === null) return frozen({ kind: "denied", code: "invalid_request" });
  let job = await dependencies.jobs.getJob(jobId);
  if (!job) return frozen({ kind: "denied", code: "job_not_found" });

  const docsHash = loadInstalledAgentKit().identity.docsHash;
  const pinned = await ensureAuthorToolBrokerPin(dependencies.jobs, job, docsHash, atMs);
  if (pinned.kind === "job_not_found") return frozen({ kind: "denied", code: "job_not_found" });
  if (pinned.kind === "job_conflict") return frozen({ kind: "denied", code: "job_conflict", job });
  if (pinned.kind !== "pinned") return frozen({ kind: "denied", code: "broker_denied", job });
  job = pinned.job;

  const brokerDecision = authorizeAuthorToolBrokerRequest(pinned.pin, job, {
    toolId: "docs.reference.read",
    source: "mcp",
    transportAvailable: dependencies.client.safeView.available
  });
  if (brokerDecision.kind === "denied") return frozen({ kind: "denied", code: "broker_denied", job });

  const timeoutMs = input.timeoutMs ?? DEFAULT_AUTHOR_MCP_TIMEOUT_MS;
  const requestHash = sha256(canonicalStringify({
    operation: "docs.reference.read",
    query: input.query,
    targetVersion: input.targetVersion,
    timeoutMs,
    connection: {
      connectionId: dependencies.client.safeView.connectionId,
      serverId: dependencies.client.safeView.serverId,
      version: dependencies.client.safeView.version,
      credentialRefId: dependencies.client.safeView.credentialRefId,
      tools: dependencies.client.safeView.tools
    }
  }));
  const reserved = await dependencies.jobs.reserveOperation(job.jobId, {
    expectedJobVersion: job.jobVersion,
    operationId: input.operationId,
    operationKind: "docs.reference.read",
    baseRevision: null,
    requestHash,
    atMs
  });
  if (reserved.kind === "replay") return replayResult(reserved.job, reserved.operation);
  if (reserved.kind === "pending") return frozen({ kind: "pending", job: reserved.job });
  if (reserved.kind === "budget_exhausted") return frozen({ kind: "paused_budget", job: reserved.job });
  if (reserved.kind === "operation_id_reused") return frozen({ kind: "denied", code: "operation_id_reused", job });
  if (reserved.kind === "job_not_runnable") return frozen({ kind: "denied", code: "job_not_runnable", job });
  if (reserved.kind === "job_version_conflict") return frozen({ kind: "denied", code: "job_conflict", job });
  if (reserved.kind !== "reserved") return frozen({ kind: "denied", code: "broker_denied", job });
  job = reserved.job;

  let persisted: AuthorAgentOperationResult;
  if (brokerDecision.kind === "unavailable") {
    persisted = referenceResult(dependencies.client, input, "unavailable", "mcp_offline", null);
  } else {
    const invoked = await invokeAuthorMcpReferenceRead(pinned.pin, job, dependencies.client, {
      query: input.query,
      targetVersion: input.targetVersion,
      timeoutMs
    }, () => atMs);
    if (invoked.kind === "completed") {
      const outputJson = canonicalStringify(invoked.output);
      persisted = referenceResult(dependencies.client, input, "completed", null, outputJson);
    } else if (invoked.kind === "unavailable") {
      persisted = referenceResult(dependencies.client, input, "unavailable", invoked.code, null);
    } else {
      persisted = referenceResult(dependencies.client, input, "invalid_response", "invalid_response", null);
    }
  }

  const completeAtMs = now(dependencies) ?? atMs;
  const activeTimeMs = Math.max(0, completeAtMs - atMs);
  const completed = await dependencies.jobs.completeOperation(job.jobId, {
    operationId: input.operationId,
    requestHash,
    result: persisted,
    activeTimeMs,
    atMs: completeAtMs
  });
  if (completed.kind === "replay") return replayResult(completed.job, completed.operation);
  if (completed.kind !== "completed") return frozen({ kind: "denied", code: "job_conflict", job });
  return replayResult(completed.job, completed.operation, false);
}

function referenceResult(
  client: AuthorMcpClient,
  input: AuthorReferenceToolBridgeInput,
  outcome: "completed" | "unavailable" | "invalid_response",
  errorCode: "mcp_offline" | "mcp_timeout" | "mcp_transport_error" | "invalid_response" | null,
  outputJson: string | null
): Extract<AuthorAgentOperationResult, { kind: "reference_read" }> {
  return deepFreeze({
    kind: "reference_read" as const,
    outcome,
    connectionId: client.safeView.connectionId,
    serverId: client.safeView.serverId,
    version: client.safeView.version,
    targetVersion: input.targetVersion,
    queryHash: sha256(input.query),
    outputJson,
    outputHash: outputJson === null ? null : sha256(outputJson),
    errorCode
  });
}

function replayResult(
  job: AuthorAgentJobRecord,
  operation: AuthorAgentOperationRecord,
  replay = true
): AuthorReferenceToolBridgeResult {
  const result = operation.result;
  if (operation.status !== "completed" || result?.kind !== "reference_read") {
    return frozen({ kind: "denied", code: "job_conflict", job });
  }
  if (result.outcome === "completed") {
    try {
      return deepFreeze({
        kind: "completed" as const,
        job,
        replay,
        connectionId: result.connectionId,
        serverId: result.serverId,
        version: result.version,
        output: JSON.parse(result.outputJson!)
      });
    } catch {
      return frozen({ kind: "invalid_response", job, replay });
    }
  }
  if (result.outcome === "unavailable") {
    return frozen({
      kind: "unavailable",
      job,
      replay,
      code: result.errorCode as "mcp_offline" | "mcp_timeout" | "mcp_transport_error"
    });
  }
  return frozen({ kind: "invalid_response", job, replay });
}

function isInput(value: unknown): value is AuthorReferenceToolBridgeInput {
  if (!isRecord(value)) return false;
  const keys = value.timeoutMs === undefined
    ? ["operationId", "query", "targetVersion"]
    : ["operationId", "query", "targetVersion", "timeoutMs"];
  return hasExactKeys(value, keys)
    && isId(value.operationId)
    && typeof value.query === "string" && value.query.length >= 1 && value.query.length <= MAX_AUTHOR_MCP_QUERY_CHARS
    && (value.targetVersion === null || isVersion(value.targetVersion))
    && (value.timeoutMs === undefined || (Number.isSafeInteger(value.timeoutMs)
      && value.timeoutMs >= 1 && value.timeoutMs <= MAX_AUTHOR_MCP_TIMEOUT_MS));
}

function now(dependencies: AuthorReferenceToolBridgeDependencies): number | null {
  const value = dependencies.nowMs ? dependencies.nowMs() : Date.now();
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, any>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function isVersion(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 100
    && /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/.test(value);
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
