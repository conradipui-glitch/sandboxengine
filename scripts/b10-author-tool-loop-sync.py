from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    if text.count(old) != 1:
        raise SystemExit(f"expected exactly one anchor in {path}: {old[:80]!r}, found {text.count(old)}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


# 1. Durable job journal: docs.reference.read is a real bounded operation with replayable result.
replace_once(
    "packages/control/src/author-agent-jobs.ts",
    'export type AuthorAgentOperationKind = "draft.read" | "proposal.preview" | "proposal.apply";',
    'export type AuthorAgentOperationKind = "draft.read" | "proposal.preview" | "proposal.apply" | "docs.reference.read";'
)

replace_once(
    "packages/control/src/author-agent-jobs.ts",
    '''export type AuthorAgentOperationResult =\n  | { readonly kind: "read_blocks"; readonly blockCount: number }\n  | { readonly kind: "proposal_previewed"; readonly proposalId: string; readonly stale: boolean; readonly applyAllowed: boolean }\n  | { readonly kind: "proposal_applied"; readonly proposalId: string; readonly resultRevision: number; readonly resultContentHash: string };''',
    '''export type AuthorAgentOperationResult =\n  | { readonly kind: "read_blocks"; readonly blockCount: number }\n  | { readonly kind: "proposal_previewed"; readonly proposalId: string; readonly stale: boolean; readonly applyAllowed: boolean }\n  | { readonly kind: "proposal_applied"; readonly proposalId: string; readonly resultRevision: number; readonly resultContentHash: string }\n  | {\n      readonly kind: "reference_read";\n      readonly outcome: "completed" | "unavailable" | "invalid_response";\n      readonly connectionId: string;\n      readonly serverId: string;\n      readonly version: string;\n      readonly targetVersion: string | null;\n      readonly queryHash: string;\n      readonly outputJson: string | null;\n      readonly outputHash: string | null;\n      readonly errorCode: "mcp_offline" | "mcp_timeout" | "mcp_transport_error" | "invalid_response" | null;\n    };'''
)

replace_once(
    "packages/control/src/author-agent-jobs.ts",
    '''  if (value.kind === "proposal_applied") {\n    return hasExactKeys(value, ["kind", "proposalId", "resultRevision", "resultContentHash"])\n      && isId(value.proposalId) && isNonNegativeSafeInteger(value.resultRevision) && isHash(value.resultContentHash);\n  }\n  return false;''',
    '''  if (value.kind === "proposal_applied") {\n    return hasExactKeys(value, ["kind", "proposalId", "resultRevision", "resultContentHash"])\n      && isId(value.proposalId) && isNonNegativeSafeInteger(value.resultRevision) && isHash(value.resultContentHash);\n  }\n  if (value.kind === "reference_read") {\n    if (!hasExactKeys(value, [\n      "kind", "outcome", "connectionId", "serverId", "version", "targetVersion", "queryHash",\n      "outputJson", "outputHash", "errorCode"\n    ])\n      || !isId(value.connectionId) || !isId(value.serverId) || !isVersion(value.version)\n      || (value.targetVersion !== null && !isVersion(value.targetVersion)) || !isHash(value.queryHash)) return false;\n    if (value.outcome === "completed") {\n      return typeof value.outputJson === "string"\n        && value.outputJson.length >= 1 && value.outputJson.length <= 64_000\n        && isJsonString(value.outputJson) && isHash(value.outputHash) && value.errorCode === null;\n    }\n    if (value.outcome === "unavailable") {\n      return value.outputJson === null && value.outputHash === null\n        && (value.errorCode === "mcp_offline" || value.errorCode === "mcp_timeout" || value.errorCode === "mcp_transport_error");\n    }\n    return value.outcome === "invalid_response"\n      && value.outputJson === null && value.outputHash === null && value.errorCode === "invalid_response";\n  }\n  return false;'''
)

replace_once(
    "packages/control/src/author-agent-jobs.ts",
    '''function isOperationKind(value: unknown): value is AuthorAgentOperationKind {\n  return value === "draft.read" || value === "proposal.preview" || value === "proposal.apply";\n}\n\nfunction isBoundedIdList''',
    '''function isOperationKind(value: unknown): value is AuthorAgentOperationKind {\n  return value === "draft.read" || value === "proposal.preview" || value === "proposal.apply" || value === "docs.reference.read";\n}\n\nfunction isVersion(value: unknown): value is string {\n  return typeof value === "string" && value.length >= 1 && value.length <= 100\n    && /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/.test(value);\n}\n\nfunction isJsonString(value: string): boolean {\n  try { JSON.parse(value); return true; } catch { return false; }\n}\n\nfunction isBoundedIdList'''
)

# 2. Broker: reference reads require an explicit job grant instead of being globally pinned.
replace_once(
    "packages/control/src/author-tool-broker.ts",
    'Object.freeze({ toolId: "docs.reference.read", operationKind: null, builtinFallback: false })',
    'Object.freeze({ toolId: "docs.reference.read", operationKind: "docs.reference.read", builtinFallback: false })'
)
replace_once(
    "packages/control/src/author-tool-broker.ts",
    'const allowed = new Set<AuthorToolId>(["docs.agent-kit.read", "docs.reference.read"]);',
    'const allowed = new Set<AuthorToolId>(["docs.agent-kit.read"]);'
)
replace_once(
    "packages/control/src/author-tool-broker.ts",
    '''  if (operationKind === "proposal.apply") return "author.proposal.apply";\n  return null;''',
    '''  if (operationKind === "proposal.apply") return "author.proposal.apply";\n  if (operationKind === "docs.reference.read") return "docs.reference.read";\n  return null;'''
)

# 3. Author jobs receive the reference-read grant only when a verified MCP client is composed.
replace_once(
    "apps/server/src/author-assistant.ts",
    '  type AuthorAgentJobRecord,\n  type AuthorAgentJobStore,',
    '  type AuthorAgentJobRecord,\n  type AuthorAgentJobStore,\n  type AuthorAgentOperationKind,'
)
replace_once(
    "apps/server/src/author-assistant.ts",
    'import { loadInstalledAgentKit } from "./agent-kit.js";',
    'import { loadInstalledAgentKit } from "./agent-kit.js";\nimport type { AuthorMcpClient } from "./author-mcp.js";'
)
replace_once(
    "apps/server/src/author-assistant.ts",
    '''  readonly capabilityCatalog?: AuthorContextCapabilityCatalog;\n  readonly nowMs?: () => number;''',
    '''  readonly capabilityCatalog?: AuthorContextCapabilityCatalog;\n  readonly referenceMcpClient?: AuthorMcpClient;\n  readonly nowMs?: () => number;'''
)
replace_once(
    "apps/server/src/author-assistant.ts",
    '''  const draft = await dependencies.store.getDraft(input.projectId, input.questId);\n  if (!draft) return frozen({ kind: "project_or_quest_not_found" });\n  const result = await dependencies.jobs.createJob({''',
    '''  const draft = await dependencies.store.getDraft(input.projectId, input.questId);\n  if (!draft) return frozen({ kind: "project_or_quest_not_found" });\n  const allowedOperations: readonly AuthorAgentOperationKind[] = dependencies.referenceMcpClient\n    ? Object.freeze(["draft.read", "proposal.preview", "proposal.apply", "docs.reference.read"] as const)\n    : Object.freeze(["draft.read", "proposal.preview", "proposal.apply"] as const);\n  const result = await dependencies.jobs.createJob({'''
)
replace_once(
    "apps/server/src/author-assistant.ts",
    '    allowedOperations: ["draft.read", "proposal.preview", "proposal.apply"],',
    '    allowedOperations,'
)

# 4. Broker tests now prove reference.read is not ambient authority.
replace_once(
    "packages/control/test/author-tool-broker.test.mjs",
    '    allowedOperations: ["draft.read", "proposal.preview", "proposal.apply"],',
    '    allowedOperations: ["draft.read", "proposal.preview", "proposal.apply", "docs.reference.read"],'
)
replace_once(
    "packages/control/test/author-tool-broker.test.mjs",
    '  assert.deepEqual(pinned.pin.allowedToolIds, ["author.draft.read", "docs.agent-kit.read", "docs.reference.read"]);',
    '  assert.deepEqual(pinned.pin.allowedToolIds, ["author.draft.read", "docs.agent-kit.read"]);'
)
replace_once(
    "packages/control/test/author-tool-broker.test.mjs",
    '''  assert.equal(deniedApply.kind, "denied");\n  assert.equal(deniedApply.code, "job_grant_required");\n});''',
    '''  assert.equal(deniedApply.kind, "denied");\n  assert.equal(deniedApply.code, "job_grant_required");\n  const deniedReference = authorizeAuthorToolBrokerRequest(pinned.pin, pinned.job, {\n    toolId: "docs.reference.read", source: "mcp", transportAvailable: true\n  });\n  assert.equal(deniedReference.kind, "denied");\n  assert.equal(deniedReference.code, "job_grant_required");\n});'''
)

# 5. Tool-loop bridge. Old AgentBackend remains no-tools; compatible backends get this separate safe bridge.
(ROOT / "apps/server/src/author-tool-loop.ts").write_text(r'''// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
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
''', encoding="utf-8")

# 6. Deterministic regressions: grant, replay, SQLite reopen, offline journaling, changed call-id denial.
(ROOT / "apps/server/test/author-tool-loop.test.mjs").write_text(r'''import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryAuthorAgentJobStore,
  MemoryAuthorAgentProposalArtifactStore,
  MemoryControlStore,
  SQLiteAuthorAgentJobStore
} from "../../../packages/control/dist/index.js";
import { ScriptedAgentBackend } from "../../../packages/ai/dist/index.js";
import { createAuthorAssistantJob } from "../dist/author-assistant.js";
import { createAuthorReferenceToolBridge } from "../dist/author-tool-loop.js";

const HASH = "a".repeat(64);
const workshop = Object.freeze({
  schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Workshop", description: "", data: Object.freeze({})
});

function mcpClient({ available = true, output = { text: "versioned docs" } } = {}) {
  const calls = [];
  return {
    calls,
    safeView: Object.freeze({
      connectionId: "context7-main",
      serverId: "context7",
      transport: "stdio",
      version: "1.0.0",
      credentialRefId: null,
      available,
      tools: Object.freeze([{ externalToolName: "resolve-library-docs", brokerToolId: "docs.reference.read" }])
    }),
    async callTool(request) {
      calls.push(request);
      return { ok: true, output };
    }
  };
}

async function seededControlStore() {
  const store = new MemoryControlStore();
  assert.equal((await store.createProject({ projectId: "p1", title: "P" })).kind, "created");
  assert.equal((await store.createQuest({
    projectId: "p1", questId: "q1", title: "Q", entryLocationId: "workshop", initialBlocks: [workshop]
  })).kind, "created");
  return store;
}

function assistantDeps(store, jobs, client) {
  return {
    store,
    jobs,
    artifacts: new MemoryAuthorAgentProposalArtifactStore(jobs),
    backend: new ScriptedAgentBackend({ backendId: "scripted-author", nowMs: () => 0 }),
    profileId: "author-profile",
    ...(client ? { referenceMcpClient: client } : {}),
    nowMs: (() => { let value = 1000; return () => value++; })()
  };
}

async function createRunningJob(store, jobId = "job-ref", maxToolCalls = 4) {
  const created = await store.createJob({
    jobId,
    projectId: "p1",
    questId: "q1",
    ownerUserId: "owner",
    startingDraftRevision: 0,
    startingDraftContentHash: HASH,
    backendId: "scripted-author",
    allowedOperations: ["draft.read", "proposal.preview", "proposal.apply", "docs.reference.read"],
    maxToolCalls,
    maxActiveTimeMs: 120000,
    createdAtMs: 1000
  });
  assert.equal(created.kind, "created");
  const started = await store.transitionJob(jobId, { expectedJobVersion: 0, to: "running", atMs: 1001 });
  assert.equal(started.kind, "updated");
  return started.job;
}

test("B10.b.11 configured author job grants reference read only when MCP reference client exists", async () => {
  const store = await seededControlStore();
  const jobsA = new MemoryAuthorAgentJobStore();
  const client = mcpClient();
  const withMcp = await createAuthorAssistantJob(assistantDeps(store, jobsA, client), {
    jobId: "job-with-mcp", projectId: "p1", questId: "q1", ownerUserId: "owner"
  });
  assert.equal(withMcp.kind, "created");
  assert.deepEqual(withMcp.job.grant.allowedOperations, [
    "draft.read", "proposal.preview", "proposal.apply", "docs.reference.read"
  ]);

  const jobsB = new MemoryAuthorAgentJobStore();
  const withoutMcp = await createAuthorAssistantJob(assistantDeps(store, jobsB, null), {
    jobId: "job-no-mcp", projectId: "p1", questId: "q1", ownerUserId: "owner"
  });
  assert.equal(withoutMcp.kind, "created");
  assert.deepEqual(withoutMcp.job.grant.allowedOperations, ["draft.read", "proposal.preview", "proposal.apply"]);
});

test("B10.b.11 bridge exposes one read tool, journals it, and exact retry replays without a second MCP call", async () => {
  const jobs = new MemoryAuthorAgentJobStore();
  await createRunningJob(jobs);
  const client = mcpClient({ output: { docs: ["v5 API"] } });
  let tick = 2000;
  const bridge = createAuthorReferenceToolBridge({ jobs, client, nowMs: () => tick++ }, "job-ref");
  assert.deepEqual(bridge.safeView.toolIds, ["docs.reference.read"]);
  assert.equal(bridge.safeView.shell, false);
  assert.equal(bridge.safeView.filesystem, false);
  assert.equal(bridge.safeView.repositoryMutation, false);
  assert.equal(bridge.safeView.codeExecution, false);
  assert.equal(bridge.safeView.deployment, false);
  assert.equal(bridge.safeView.secretRead, false);

  const input = { operationId: "docs-1", query: "How does API v5 work?", targetVersion: "5.0.0" };
  const first = await bridge.readReference(input);
  assert.equal(first.kind, "completed");
  assert.equal(first.replay, false);
  assert.deepEqual(first.output, { docs: ["v5 API"] });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].arguments.targetVersion, "5.0.0");
  assert.equal(first.job.toolCallsUsed, 1);

  const replay = await bridge.readReference(input);
  assert.equal(replay.kind, "completed");
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.output, first.output);
  assert.equal(client.calls.length, 1);
  assert.equal(replay.job.toolCallsUsed, 1);

  const changed = await bridge.readReference({ ...input, query: "Different query" });
  assert.equal(changed.kind, "denied");
  assert.equal(changed.code, "operation_id_reused");
  assert.equal(client.calls.length, 1);
});

test("B10.b.11 offline MCP result is durable, budgeted and replayed without implicit fallback", async () => {
  const jobs = new MemoryAuthorAgentJobStore();
  await createRunningJob(jobs, "job-offline", 2);
  const client = mcpClient({ available: false });
  let tick = 3000;
  const bridge = createAuthorReferenceToolBridge({ jobs, client, nowMs: () => tick++ }, "job-offline");
  const input = { operationId: "offline-1", query: "Need exact dependency docs", targetVersion: "4.2.0" };

  const first = await bridge.readReference(input);
  assert.equal(first.kind, "unavailable");
  assert.equal(first.code, "mcp_offline");
  assert.equal(first.replay, false);
  assert.equal(first.job.toolCallsUsed, 1);
  assert.equal(client.calls.length, 0);

  const replay = await bridge.readReference(input);
  assert.equal(replay.kind, "unavailable");
  assert.equal(replay.code, "mcp_offline");
  assert.equal(replay.replay, true);
  assert.equal(replay.job.toolCallsUsed, 1);
  assert.equal(client.calls.length, 0);
});

test("B10.b.11 completed reference operation survives SQLite reopen and replays exact output", async () => {
  const root = mkdtempSync(join(tmpdir(), "lh-b10-ref-tool-"));
  const path = join(root, "control.sqlite");
  try {
    let jobs = new SQLiteAuthorAgentJobStore({ path });
    await createRunningJob(jobs, "job-sqlite-ref", 4);
    const clientA = mcpClient({ output: { answer: "pinned 2.1 docs" } });
    let tick = 4000;
    let bridge = createAuthorReferenceToolBridge({ jobs, client: clientA, nowMs: () => tick++ }, "job-sqlite-ref");
    const input = { operationId: "sqlite-docs-1", query: "Pinned API", targetVersion: "2.1.0" };
    const first = await bridge.readReference(input);
    assert.equal(first.kind, "completed");
    assert.equal(first.replay, false);
    assert.equal(clientA.calls.length, 1);
    jobs.close();

    jobs = new SQLiteAuthorAgentJobStore({ path });
    const clientB = mcpClient({ output: { answer: "SHOULD NOT BE CALLED" } });
    bridge = createAuthorReferenceToolBridge({ jobs, client: clientB, nowMs: () => tick++ }, "job-sqlite-ref");
    const replay = await bridge.readReference(input);
    assert.equal(replay.kind, "completed");
    assert.equal(replay.replay, true);
    assert.deepEqual(replay.output, { answer: "pinned 2.1 docs" });
    assert.equal(clientB.calls.length, 0);
    assert.equal(replay.job.toolCallsUsed, 1);
    jobs.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B10.b.11 a job without docs.reference.read grant is denied before MCP transport", async () => {
  const jobs = new MemoryAuthorAgentJobStore();
  const created = await jobs.createJob({
    jobId: "job-no-ref",
    projectId: "p1",
    questId: "q1",
    ownerUserId: "owner",
    startingDraftRevision: 0,
    startingDraftContentHash: HASH,
    backendId: "scripted-author",
    allowedOperations: ["draft.read"],
    createdAtMs: 5000
  });
  assert.equal(created.kind, "created");
  assert.equal((await jobs.transitionJob("job-no-ref", { expectedJobVersion: 0, to: "running", atMs: 5001 })).kind, "updated");
  const client = mcpClient();
  const bridge = createAuthorReferenceToolBridge({ jobs, client, nowMs: () => 5002 }, "job-no-ref");
  const result = await bridge.readReference({ operationId: "denied-ref", query: "docs", targetVersion: null });
  assert.equal(result.kind, "denied");
  assert.equal(result.code, "broker_denied");
  assert.equal(client.calls.length, 0);
});
''', encoding="utf-8")

# 7. Truthful checkpoint/worklog.
task = ROOT / "docs/tasks/B10-author-assistant.md"
text = task.read_text(encoding="utf-8")
old = '''**B10.b.11 broker foundation and read-only MCP transport contract are implemented:** server-owned broker policy/default-deny is independent of Skill/MCP text; the active installed docs/Skill hash, broker policy hash and exact job-granted tool set are pinned durably in the job checkpoint journal; current draft read/proposal preview/apply paths pass broker authorization; shell/filesystem/repository/code/deployment/secret tool IDs are not in the trusted catalog. The trusted catalog now also contains `docs.reference.read`, implemented only through a bounded MCP client contract with verified configuration, explicit query + target version, deadline/output limits and typed offline/timeout/invalid-response results. MCP connections cannot bind write tools in this slice, arbitrary URLs/process commands are not accepted from task text, and fallback is never executed automatically.\n\nNext bounded slice after exact-head root CI: **finish B10.b.11 backend tool-loop integration** — journal/budget the brokered reference read as a durable job operation and expose only that read capability to a compatible author backend/tool bridge. Do not start external task package, Codex adapter, shell/filesystem/repository/deployment authority, or mark broad `control.capabilities` available merely because MCP transport internals exist.'''
new = '''**B10.b.11 broker foundation, bounded MCP transport and durable reference-read bridge are implemented:** server-owned broker policy/default-deny is independent of Skill/MCP text; the active installed docs/Skill hash, broker policy hash and exact job-granted tool set are pinned durably in the job checkpoint journal; current draft read/proposal preview/apply paths pass broker authorization; shell/filesystem/repository/code/deployment/secret tool IDs are not in the trusted catalog. `docs.reference.read` is no longer ambient broker authority: it is a distinct job-granted operation only when a verified reference MCP client is composed, and each call is reserved in the durable operation journal before transport, consumes segment tool/time budget, records exact connection/version/query identity plus bounded result/failure, and replays without a second MCP call after response loss or SQLite reopen. A separate safe bridge exposes exactly that read tool while the existing `AgentBackend` remains `toolPolicy: none`; offline/timeout/invalid-response are typed and no fallback is executed automatically. MCP connections cannot bind write tools, arbitrary URLs/process commands are not accepted from task text, and mid-job policy/docs changes remain pinned/fail-closed.\n\nNext bounded slice after exact-head root CI: **finish B10.b.11 compatible backend tool-loop protocol** — let a deterministic tool-aware author backend request only the safe bridge tool, feed the bounded returned reference material into the same segment, and prove call-count/deadline/cancel/budget behavior without changing the existing no-tools `AgentBackend` contract. Do not start external task package, Codex adapter, shell/filesystem/repository/deployment authority, or mark broad `control.capabilities` available in this slice.'''
if text.count(old) != 1:
    raise SystemExit("B10 task checkpoint anchor missing")
task.write_text(text.replace(old, new, 1), encoding="utf-8")

(ROOT / "docs/worklog/2026-09-08-b10-author-reference-tool-loop.md").write_text('''# B10.b.11 — durable author reference tool loop\n\nBounded slice: make `docs.reference.read` explicit job authority instead of ambient broker authority, journal/budget it before MCP transport, and expose one read-only safe bridge without widening the existing `AgentBackend` contract.\n\nEvidence required before GREEN:\n\n- reduced grants cannot call `docs.reference.read`;\n- configured author jobs gain exactly that operation and no shell/fs/repo/code/deploy/secret authority;\n- exact retry replays the durable result without a second MCP call;\n- changed request under the same operation ID is denied;\n- offline is journaled/budgeted and never auto-falls back;\n- completed reference output replays after SQLite reopen;\n- targeted Control/Server/boundary/docs checks and then exact-head root `npm run verify` are green.\n''', encoding="utf-8")
