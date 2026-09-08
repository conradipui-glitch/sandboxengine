from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: anchor {label!r}: expected 1, found {count}")
    p.write_text(text.replace(old, new, 1))


broker = r'''// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
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
  "docs.agent-kit.read"
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
  Object.freeze({ toolId: "docs.agent-kit.read", operationKind: null, builtinFallback: true })
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
  const allowed = new Set<AuthorToolId>(["docs.agent-kit.read"]);
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
'''
Path("packages/control/src/author-tool-broker.ts").write_text(broker)

broker_test = r'''import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryAuthorAgentJobStore,
  SQLiteAuthorAgentJobStore
} from "../dist/author-agent-jobs.js";
import {
  AUTHOR_TOOL_BROKER_POLICY_HASH,
  AUTHOR_TOOL_BROKER_POLICY_VERSION,
  authorizeAuthorToolBrokerRequest,
  ensureAuthorToolBrokerPin
} from "../dist/author-tool-broker.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function createInput(jobId = "job-broker") {
  return {
    jobId,
    projectId: "p1",
    questId: "q1",
    ownerUserId: "owner",
    startingDraftRevision: 2,
    startingDraftContentHash: HASH_A,
    backendId: "scripted-author",
    allowedOperations: ["draft.read", "proposal.preview", "proposal.apply"],
    maxToolCalls: 12,
    maxActiveTimeMs: 120000,
    createdAtMs: 1000
  };
}

async function runningJob(store, jobId = "job-broker") {
  const created = await store.createJob(createInput(jobId));
  assert.equal(created.kind, "created");
  const started = await store.transitionJob(jobId, { expectedJobVersion: 0, to: "running", atMs: 1001 });
  assert.equal(started.kind, "updated");
  return started.job;
}

test("B10.b.11 broker pins server policy and third-party Skill/MCP text cannot grant forbidden authority", async () => {
  const store = new MemoryAuthorAgentJobStore();
  let job = await runningJob(store);
  const pinned = await ensureAuthorToolBrokerPin(store, job, HASH_A, 1002);
  assert.equal(pinned.kind, "pinned");
  assert.equal(pinned.newlyPinned, true);
  job = pinned.job;
  assert.equal(pinned.pin.policyVersion, AUTHOR_TOOL_BROKER_POLICY_VERSION);
  assert.equal(pinned.pin.policyHash, AUTHOR_TOOL_BROKER_POLICY_HASH);
  assert.equal(pinned.pin.installedDocsHash, HASH_A);
  assert.deepEqual(pinned.pin.allowedToolIds, [
    "author.draft.read",
    "author.proposal.apply",
    "author.proposal.preview",
    "docs.agent-kit.read"
  ]);
  assert.equal(Object.isFrozen(pinned.pin), true);
  assert.equal(Object.isFrozen(pinned.pin.allowedToolIds), true);

  const safeSkill = authorizeAuthorToolBrokerRequest(pinned.pin, job, {
    toolId: "author.draft.read", source: "skill"
  });
  assert.deepEqual(safeSkill, {
    kind: "allowed", toolId: "author.draft.read", source: "skill", operationKind: "draft.read"
  });

  for (const [toolId, source] of [
    ["shell.exec", "skill"],
    ["filesystem.read", "mcp"],
    ["repository.write", "skill"],
    ["code.execute", "mcp"],
    ["deployment.run", "skill"],
    ["secret.read", "mcp"]
  ]) {
    const denied = authorizeAuthorToolBrokerRequest(pinned.pin, job, { toolId, source, transportAvailable: true });
    assert.equal(denied.kind, "denied");
    assert.equal(denied.code, "tool_not_allowed");
  }

  const offline = authorizeAuthorToolBrokerRequest(pinned.pin, job, {
    toolId: "docs.agent-kit.read", source: "mcp", transportAvailable: false
  });
  assert.deepEqual(offline, {
    kind: "unavailable",
    code: "mcp_unavailable",
    toolId: "docs.agent-kit.read",
    fallback: { source: "builtin", toolId: "docs.agent-kit.read" }
  });
  const explicitFallback = authorizeAuthorToolBrokerRequest(pinned.pin, job, offline.fallback);
  assert.equal(explicitFallback.kind, "allowed");
  assert.equal(explicitFallback.source, "builtin");

  const checkpoints = await store.listCheckpoints(job.jobId);
  const brokerFacts = checkpoints.filter((entry) => entry.fact.kind === "broker.pinned");
  assert.equal(brokerFacts.length, 1);
  assert.equal(brokerFacts[0].fact.contractHash, pinned.pin.contractHash);

  const same = await ensureAuthorToolBrokerPin(store, job, HASH_A, 1003);
  assert.equal(same.kind, "pinned");
  assert.equal(same.newlyPinned, false);
  assert.equal(same.pin.contractHash, pinned.pin.contractHash);

  const changedSkill = await ensureAuthorToolBrokerPin(store, job, HASH_B, 1004);
  assert.equal(changedSkill.kind, "pinned_mismatch");
  assert.equal(changedSkill.pin.installedDocsHash, HASH_A);
  assert.equal(changedSkill.currentPin.installedDocsHash, HASH_B);
  assert.equal((await store.listCheckpoints(job.jobId)).filter((entry) => entry.fact.kind === "broker.pinned").length, 1);
});

test("B10.b.11 broker pin survives SQLite reopen and does not silently adopt a new docs/Skill hash", async () => {
  const root = mkdtempSync(join(tmpdir(), "lh-b10-broker-"));
  const path = join(root, "control.sqlite");
  try {
    let store = new SQLiteAuthorAgentJobStore({ path });
    let job = await runningJob(store, "job-sqlite-broker");
    const first = await ensureAuthorToolBrokerPin(store, job, HASH_A, 1002);
    assert.equal(first.kind, "pinned");
    assert.equal(first.newlyPinned, true);
    const contractHash = first.pin.contractHash;
    store.close();

    store = new SQLiteAuthorAgentJobStore({ path });
    job = await store.getJob("job-sqlite-broker");
    assert.ok(job);
    const reopened = await ensureAuthorToolBrokerPin(store, job, HASH_A, 1003);
    assert.equal(reopened.kind, "pinned");
    assert.equal(reopened.newlyPinned, false);
    assert.equal(reopened.pin.contractHash, contractHash);

    const changed = await ensureAuthorToolBrokerPin(store, reopened.job, HASH_B, 1004);
    assert.equal(changed.kind, "pinned_mismatch");
    assert.equal(changed.pin.contractHash, contractHash);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B10.b.11 broker never widens a reduced job grant", async () => {
  const store = new MemoryAuthorAgentJobStore();
  const created = await store.createJob({ ...createInput("job-read-only"), allowedOperations: ["draft.read"] });
  assert.equal(created.kind, "created");
  const started = await store.transitionJob("job-read-only", { expectedJobVersion: 0, to: "running", atMs: 1001 });
  assert.equal(started.kind, "updated");
  const pinned = await ensureAuthorToolBrokerPin(store, started.job, HASH_A, 1002);
  assert.equal(pinned.kind, "pinned");
  assert.deepEqual(pinned.pin.allowedToolIds, ["author.draft.read", "docs.agent-kit.read"]);
  const deniedApply = authorizeAuthorToolBrokerRequest(pinned.pin, pinned.job, {
    toolId: "author.proposal.apply", source: "skill"
  });
  assert.equal(deniedApply.kind, "denied");
  assert.equal(deniedApply.code, "job_grant_required");
});
'''
Path("packages/control/test/author-tool-broker.test.mjs").write_text(broker_test)

# Durable broker pin fact lives in the existing checkpoint journal (Memory + SQLite).
replace_once(
    "packages/control/src/author-agent-jobs.ts",
    '''  | { readonly kind: "segment.requested"; readonly requestId: string; readonly requestHash: string }
''',
    '''  | {
      readonly kind: "broker.pinned";
      readonly policyVersion: string;
      readonly policyHash: string;
      readonly installedDocsHash: string;
      readonly contractHash: string;
      readonly allowedToolIds: readonly string[];
    }
  | { readonly kind: "segment.requested"; readonly requestId: string; readonly requestHash: string }
''',
    "broker checkpoint type"
)
replace_once(
    "packages/control/src/author-agent-jobs.ts",
    '''    case "segment.requested":
      return hasExactKeys(value, ["kind", "requestId", "requestHash"])
        && isId(value.requestId) && isHash(value.requestHash);
''',
    '''    case "broker.pinned":
      return hasExactKeys(value, [
        "kind", "policyVersion", "policyHash", "installedDocsHash", "contractHash", "allowedToolIds"
      ])
        && isId(value.policyVersion)
        && isHash(value.policyHash)
        && isHash(value.installedDocsHash)
        && isHash(value.contractHash)
        && isBoundedIdList(value.allowedToolIds, 16, 1);
    case "segment.requested":
      return hasExactKeys(value, ["kind", "requestId", "requestHash"])
        && isId(value.requestId) && isHash(value.requestHash);
''',
    "broker checkpoint validation"
)

# Public Control contract exports the broker.
replace_once(
    "packages/control/src/index.ts",
    '''export {
  MemoryAuthorAgentProposalArtifactStore,
''',
    '''export {
  AUTHOR_TOOL_BROKER_POLICY_HASH,
  AUTHOR_TOOL_BROKER_POLICY_VERSION,
  AUTHOR_TOOL_IDS,
  authorizeAuthorToolBrokerRequest,
  buildAuthorToolBrokerPin,
  ensureAuthorToolBrokerPin,
  type AuthorToolBrokerDecision,
  type AuthorToolBrokerPin,
  type AuthorToolBrokerRequest,
  type AuthorToolId,
  type AuthorToolSource,
  type BuildAuthorToolBrokerPinResult,
  type EnsureAuthorToolBrokerPinResult
} from "./author-tool-broker.js";
export {
  MemoryAuthorAgentProposalArtifactStore,
''',
    "broker exports"
)

# Server assistant pins the installed docs/Skill identity and gates every current author operation.
replace_once(
    "apps/server/src/author-assistant.ts",
    '''  applyAuthoringProposalFromStore,
  buildAuthorContextBundle,
  previewAuthoringProposalFromStore,
''',
    '''  applyAuthoringProposalFromStore,
  authorizeAuthorToolBrokerRequest,
  buildAuthorContextBundle,
  ensureAuthorToolBrokerPin,
  previewAuthoringProposalFromStore,
''',
    "server broker imports"
)
replace_once(
    "apps/server/src/author-assistant.ts",
    '''} from "@living-history/ai";

const MAX_AUTHOR_INSTRUCTION_CHARS''',
    '''} from "@living-history/ai";
import { loadInstalledAgentKit } from "./agent-kit.js";

const MAX_AUTHOR_INSTRUCTION_CHARS''',
    "server installed kit import"
)
replace_once(
    "apps/server/src/author-assistant.ts",
    '''  | { readonly kind: "job_conflict"; readonly job: AuthorAgentJobRecord };
''',
    '''  | { readonly kind: "job_conflict"; readonly job: AuthorAgentJobRecord }
  | { readonly kind: "broker_failure"; readonly code: "contract_changed" | "invalid_pin" | "operation_denied"; readonly job: AuthorAgentJobRecord };
''',
    "broker result union"
)
replace_once(
    "apps/server/src/author-assistant.ts",
    '''  if (job.state !== "running") return frozen({ kind: "job_conflict", job });

  const current = await dependencies.store.getDraft(job.projectId, job.questId);
''',
    '''  if (job.state !== "running") return frozen({ kind: "job_conflict", job });

  const installedDocsHash = loadInstalledAgentKit().identity.docsHash;
  const brokerPinned = await ensureAuthorToolBrokerPin(dependencies.jobs, job, installedDocsHash, now(dependencies));
  if (brokerPinned.kind === "job_not_found") return frozen({ kind: "job_not_found" });
  if (brokerPinned.kind === "job_conflict") return jobConflict(dependencies, job.jobId);
  if (brokerPinned.kind === "pinned_mismatch") return failBroker(dependencies, job, "contract_changed");
  if (brokerPinned.kind === "invalid_pin" || brokerPinned.kind === "invalid_request") {
    return failBroker(dependencies, job, "invalid_pin");
  }
  job = brokerPinned.job;
  const brokerPin = brokerPinned.pin;
  if (authorizeAuthorToolBrokerRequest(brokerPin, job, {
    toolId: "author.draft.read", source: "builtin"
  }).kind !== "allowed") return failBroker(dependencies, job, "operation_denied");

  const current = await dependencies.store.getDraft(job.projectId, job.questId);
''',
    "pin broker and gate draft read"
)
replace_once(
    "apps/server/src/author-assistant.ts",
    '''  const previewOperationId = `preview-${proposal.proposalId.slice("proposal-".length)}`;
''',
    '''  if (authorizeAuthorToolBrokerRequest(brokerPin, job, {
    toolId: "author.proposal.preview", source: "builtin"
  }).kind !== "allowed") return failBroker(dependencies, job, "operation_denied");
  const previewOperationId = `preview-${proposal.proposalId.slice("proposal-".length)}`;
''',
    "gate proposal preview"
)
replace_once(
    "apps/server/src/author-assistant.ts",
    '''  const applyOperationId = `apply-${proposal.proposalId.slice("proposal-".length)}`;
''',
    '''  if (authorizeAuthorToolBrokerRequest(brokerPin, job, {
    toolId: "author.proposal.apply", source: "builtin"
  }).kind !== "allowed") return failBroker(dependencies, job, "operation_denied");
  const applyOperationId = `apply-${proposal.proposalId.slice("proposal-".length)}`;
''',
    "gate proposal apply"
)
replace_once(
    "apps/server/src/author-assistant.ts",
    '''async function failBackend(
''',
    '''async function failBroker(
  dependencies: AuthorAssistantDependencies,
  job: AuthorAgentJobRecord,
  code: "contract_changed" | "invalid_pin" | "operation_denied"
): Promise<RunAuthorAssistantSegmentResult> {
  const failed = await markFailed(dependencies, job, `broker.${code}`);
  return frozen({ kind: "broker_failure", code, job: failed });
}

async function failBackend(
''',
    "broker fail helper"
)

# Manual job-scoped proposal Apply uses the same pinned broker contract before the existing kit handshake.
replace_once(
    "apps/server/src/author-job-http.ts",
    '''  DEFAULT_AUTHOR_AGENT_MAX_TOOL_CALLS,
  applyAuthoringProposalFromStore,
''',
    '''  DEFAULT_AUTHOR_AGENT_MAX_TOOL_CALLS,
  applyAuthoringProposalFromStore,
  authorizeAuthorToolBrokerRequest,
  ensureAuthorToolBrokerPin,
''',
    "job http broker imports"
)
replace_once(
    "apps/server/src/author-job-http.ts",
    '''} from "./author-assistant.js";

const ACTIVE_AUTHOR_SEGMENTS''',
    '''} from "./author-assistant.js";
import { loadInstalledAgentKit } from "./agent-kit.js";

const ACTIVE_AUTHOR_SEGMENTS''',
    "job http installed kit import"
)
replace_once(
    "apps/server/src/author-job-http.ts",
    '''    const job = await ownedJob(context.authorAssistant, projectId, questId, jobId, context.actorUserId);
    if (!job) { context.sendNotFound(); return true; }
    if (job.state !== "waiting_user" && job.state !== "paused_budget") {
''',
    '''    let job = await ownedJob(context.authorAssistant, projectId, questId, jobId, context.actorUserId);
    if (!job) { context.sendNotFound(); return true; }
    if (job.state !== "waiting_user" && job.state !== "paused_budget") {
''',
    "manual apply mutable job"
)
replace_once(
    "apps/server/src/author-job-http.ts",
    '''    if (!context.requireAgentKitHandshake()) return true;
    const applied = await applyAuthoringProposalFromStore(context.authorAssistant.store, proposal, idempotencyKey);
''',
    '''    const brokerAuthorized = await authorizeJobApplyBroker(context, job);
    if (brokerAuthorized === null) return true;
    job = brokerAuthorized;
    if (!context.requireAgentKitHandshake()) return true;
    const applied = await applyAuthoringProposalFromStore(context.authorAssistant.store, proposal, idempotencyKey);
''',
    "manual apply broker gate"
)
replace_once(
    "apps/server/src/author-job-http.ts",
    '''async function ensureAppliedCheckpoint(
''',
    '''async function authorizeJobApplyBroker(
  context: AuthorJobHttpContext,
  job: AuthorAgentJobRecord
): Promise<AuthorAgentJobRecord | null> {
  if (context.authorAssistant === null) return null;
  const pinned = await ensureAuthorToolBrokerPin(
    context.authorAssistant.jobs,
    job,
    loadInstalledAgentKit().identity.docsHash,
    now(context.authorAssistant)
  );
  if (pinned.kind === "pinned_mismatch") {
    context.sendJson(409, { error: { code: "AUTHOR_BROKER_CONTRACT_CHANGED" }, job });
    return null;
  }
  if (pinned.kind === "job_conflict") {
    context.sendJson(409, { error: { code: "AUTHOR_JOB_CONFLICT", currentJobVersion: pinned.currentJobVersion } });
    return null;
  }
  if (pinned.kind !== "pinned") {
    context.sendJson(409, { error: { code: "AUTHOR_BROKER_INVALID_PIN" }, job });
    return null;
  }
  const decision = authorizeAuthorToolBrokerRequest(pinned.pin, pinned.job, {
    toolId: "author.proposal.apply",
    source: "builtin"
  });
  if (decision.kind !== "allowed") {
    context.sendJson(403, { error: { code: "AUTHOR_BROKER_OPERATION_DENIED" }, job: pinned.job });
    return null;
  }
  return pinned.job;
}

async function ensureAppliedCheckpoint(
''',
    "job apply broker helper"
)
replace_once(
    "apps/server/src/author-job-http.ts",
    '''  if (result.kind === "cancelled" || result.kind === "terminal" || result.kind === "job_conflict") {
''',
    '''  if (result.kind === "broker_failure") {
    context.sendJson(409, { error: { code: `AUTHOR_BROKER_${result.code.toUpperCase()}` }, job: result.job });
    return;
  }
  if (result.kind === "cancelled" || result.kind === "terminal" || result.kind === "job_conflict") {
''',
    "broker segment response"
)

# Server regression proves the real author path recorded a broker pin before authoring operations.
replace_once(
    "apps/server/test/author-assistant.test.mjs",
    '''  assert.ok(checkpoints.some((entry) => entry.fact.kind === "draft.read"));
''',
    '''  const brokerPin = checkpoints.find((entry) => entry.fact.kind === "broker.pinned");
  assert.ok(brokerPin);
  assert.match(brokerPin.fact.policyHash, /^[a-f0-9]{64}$/);
  assert.match(brokerPin.fact.installedDocsHash, /^[a-f0-9]{64}$/);
  assert.match(brokerPin.fact.contractHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(brokerPin.fact.allowedToolIds, [
    "author.draft.read", "author.proposal.apply", "author.proposal.preview", "docs.agent-kit.read"
  ]);
  assert.ok(checkpoints.some((entry) => entry.fact.kind === "draft.read"));
''',
    "server broker checkpoint evidence"
)

# Studio renders the new factual checkpoint rather than losing exhaustiveness.
replace_once(
    "apps/studio/src/author-assistant.ts",
    '''    case "context.selected": return `Context r${fact.draftRevision}: selected ${fact.selectedBlockIds.length}, included ${fact.includedBlockIds.length}`;
    case "proposal.produced": return `Сформирован ${fact.proposalId}`;
''',
    '''    case "context.selected": return `Context r${fact.draftRevision}: selected ${fact.selectedBlockIds.length}, included ${fact.includedBlockIds.length}`;
    case "broker.pinned": return `Broker pinned ${fact.policyVersion}: ${fact.allowedToolIds.length} tools`;
    case "proposal.produced": return `Сформирован ${fact.proposalId}`;
''',
    "studio broker checkpoint label"
)

# Truthful task checkpoint: recipes are closed; §11 foundation is current, not the whole MCP integration.
replace_once(
    "docs/tasks/B10-author-assistant.md",
    '''**B10.b.10 handshake foundation is implemented:** generated compatibility now includes deterministic `apiHash` and aggregate `docsHash`; authenticated `GET /control/v1/agent-kit` returns the exact installed generated kit; `control.agent-kit` is available while `control.capabilities` remains planned; direct proposal Apply and job-scoped Apply both require exact installed engine/registry/docs identity immediately before draft mutation; missing or stale identity returns `AGENT_KIT_STALE` without draft mutation; Studio refreshes the installed kit before Apply and the loopback proxy forwards only the explicitly allowlisted handshake headers. The remaining §10 work is checked recipe content and recipe verification, not MCP authority.

Next bounded slice after exact-head root CI: **finish B10.b.10 checked agent-kit recipes only** — quest authoring, scene presentation, plugin extension, UI/provider extension and migration validation recipes, generated from current contracts and verified against repository commands/paths. Do not start the Skills/MCP broker, external task package, Codex adapter, shell/filesystem/repository/deployment authority, or mark `control.capabilities` available in this slice.
''',
    '''**B10.b.10 is closed:** generated compatibility includes deterministic `apiHash` and aggregate `docsHash`; authenticated `GET /control/v1/agent-kit` returns the exact installed generated kit; direct proposal Apply and job-scoped Apply require exact installed engine/registry/docs identity; Studio refreshes the installed kit before Apply; and five checked generated recipes (quest authoring, scene presentation, plugin extension, UI/provider extension, migration validation) participate in `docsHash`. Recipe generation fails closed on missing repository paths or verification commands outside the explicit safe allowlist/root scripts. `control.agent-kit` is available while broad `control.capabilities` remains planned.

**B10.b.11 broker foundation is the current bounded slice:** server-owned broker policy/default-deny is independent of Skill/MCP text; the active installed docs/Skill hash, broker policy hash and exact job-granted tool set are pinned durably in the job checkpoint journal; current draft read/proposal preview/apply paths pass broker authorization; shell/filesystem/repository/code/deployment/secret tool IDs are not in the trusted catalog; MCP transport unavailability is typed and any builtin fallback is explicit rather than automatic. This foundation does not yet claim a live third-party MCP transport.

Next bounded slice after exact-head root CI: **finish B10.b.11 transport integration** with a bounded read-only MCP adapter/timeout-offline contract behind this policy, preserving the existing pin and default-deny semantics. Do not start external task package, Codex adapter, shell/filesystem/repository/deployment authority, or mark broad `control.capabilities` available merely because broker internals exist.
''',
    "task checkpoint broker foundation"
)

print("B10.b.11 author tool broker foundation patch applied")
