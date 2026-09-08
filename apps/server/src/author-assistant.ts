// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
import { createHash } from "node:crypto";
import {
  applyAuthoringProposalFromStore,
  previewAuthoringProposalFromStore,
  type AuthorAgentJobRecord,
  type AuthorAgentJobStore,
  type AuthoringProposal,
  type AuthoringProposalApplication,
  type AuthoringProposalPreview,
  type ControlStore,
  type DraftChange,
  type DraftSnapshot,
  type MissingAuthoringCapability
} from "@living-history/control";
import { canonicalStringify } from "@living-history/core";
import {
  assertRuntimeSafeAgentBackend,
  type AgentBackend,
  type AgentBackendErrorCode,
  type ProviderUsage
} from "@living-history/ai";

const MAX_AUTHOR_INSTRUCTION_CHARS = 20_000;
const MAX_AUTHOR_CONTEXT_CHARS = 64_000;
const DEFAULT_AUTHOR_BACKEND_DEADLINE_MS = 60_000;
const MAX_AUTHOR_BACKEND_DEADLINE_MS = 120_000;
const AUTHOR_MAX_OUTPUT_TOKENS = 8_192;

export interface AuthorAssistantDependencies {
  readonly store: ControlStore;
  readonly jobs: AuthorAgentJobStore;
  readonly backend: AgentBackend;
  readonly profileId: string;
  readonly nowMs?: () => number;
  readonly backendDeadlineMs?: number;
}

export interface CreateAuthorAssistantJobInput {
  readonly jobId: string;
  readonly projectId: string;
  readonly questId: string;
  readonly ownerUserId: string;
  readonly maxToolCalls?: number;
  readonly maxActiveTimeMs?: number;
}

export type CreateAuthorAssistantJobResult =
  | { readonly kind: "created"; readonly job: AuthorAgentJobRecord }
  | { readonly kind: "project_or_quest_not_found" }
  | { readonly kind: "job_exists" }
  | { readonly kind: "invalid_request" };

export interface RunAuthorAssistantSegmentInput {
  readonly jobId: string;
  readonly instruction: string;
  readonly autoApply: boolean;
  readonly resumeBudget?: boolean;
}

export type RunAuthorAssistantSegmentResult =
  | {
      readonly kind: "proposal_ready";
      readonly job: AuthorAgentJobRecord;
      readonly proposal: AuthoringProposal;
      readonly preview: AuthoringProposalPreview;
      readonly usage: ProviderUsage;
    }
  | {
      readonly kind: "applied";
      readonly job: AuthorAgentJobRecord;
      readonly proposal: AuthoringProposal;
      readonly preview: AuthoringProposalPreview;
      readonly draft: DraftSnapshot;
      readonly application: AuthoringProposalApplication;
      readonly usage: ProviderUsage;
    }
  | { readonly kind: "paused_budget"; readonly job: AuthorAgentJobRecord }
  | { readonly kind: "cancelled"; readonly job: AuthorAgentJobRecord }
  | { readonly kind: "terminal"; readonly job: AuthorAgentJobRecord }
  | { readonly kind: "job_not_found" }
  | { readonly kind: "invalid_request" }
  | { readonly kind: "starting_snapshot_unavailable"; readonly job: AuthorAgentJobRecord }
  | { readonly kind: "backend_failure"; readonly code: AgentBackendErrorCode; readonly job: AuthorAgentJobRecord; readonly usage: ProviderUsage }
  | { readonly kind: "invalid_backend_output"; readonly job: AuthorAgentJobRecord; readonly usage: ProviderUsage }
  | { readonly kind: "proposal_invalid"; readonly job: AuthorAgentJobRecord; readonly details: readonly string[]; readonly usage: ProviderUsage }
  | { readonly kind: "proposal_base_conflict"; readonly job: AuthorAgentJobRecord; readonly currentRevision: number; readonly currentContentHash: string; readonly usage: ProviderUsage }
  | { readonly kind: "store_unavailable"; readonly job: AuthorAgentJobRecord; readonly usage: ProviderUsage }
  | { readonly kind: "job_conflict"; readonly job: AuthorAgentJobRecord };

export async function createAuthorAssistantJob(
  dependencies: AuthorAssistantDependencies,
  input: CreateAuthorAssistantJobInput
): Promise<CreateAuthorAssistantJobResult> {
  assertRuntimeSafeAgentBackend(dependencies.backend.safeView);
  if (!isId(input.jobId) || !isId(input.projectId) || !isId(input.questId) || !isId(input.ownerUserId)) {
    return frozen({ kind: "invalid_request" });
  }
  const draft = await dependencies.store.getDraft(input.projectId, input.questId);
  if (!draft) return frozen({ kind: "project_or_quest_not_found" });
  const result = await dependencies.jobs.createJob({
    jobId: input.jobId,
    projectId: input.projectId,
    questId: input.questId,
    ownerUserId: input.ownerUserId,
    startingDraftRevision: draft.draftRevision,
    startingDraftContentHash: draft.contentHash,
    backendId: dependencies.backend.safeView.backendId,
    allowedOperations: ["draft.read", "proposal.preview", "proposal.apply"],
    ...(input.maxToolCalls === undefined ? {} : { maxToolCalls: input.maxToolCalls }),
    ...(input.maxActiveTimeMs === undefined ? {} : { maxActiveTimeMs: input.maxActiveTimeMs }),
    createdAtMs: now(dependencies)
  });
  if (result.kind === "created" || result.kind === "job_exists" || result.kind === "invalid_request") return result;
  return frozen({ kind: "invalid_request" });
}

export async function runAuthorAssistantSegment(
  dependencies: AuthorAssistantDependencies,
  input: RunAuthorAssistantSegmentInput
): Promise<RunAuthorAssistantSegmentResult> {
  assertRuntimeSafeAgentBackend(dependencies.backend.safeView);
  if (!isId(input.jobId) || typeof input.instruction !== "string" || input.instruction.length < 1
    || input.instruction.length > MAX_AUTHOR_INSTRUCTION_CHARS || typeof input.autoApply !== "boolean") {
    return frozen({ kind: "invalid_request" });
  }
  const deadlineMs = normalizedDeadlineMs(dependencies.backendDeadlineMs);
  if (deadlineMs === null || !isId(dependencies.profileId)) return frozen({ kind: "invalid_request" });

  let job = await dependencies.jobs.getJob(input.jobId);
  if (!job) return frozen({ kind: "job_not_found" });
  if (job.backendId !== dependencies.backend.safeView.backendId) return frozen({ kind: "invalid_request" });
  if (job.state === "cancelled") return frozen({ kind: "cancelled", job });
  if (job.state === "succeeded" || job.state === "failed") return frozen({ kind: "terminal", job });
  if (job.state === "paused_budget" && input.resumeBudget !== true) return frozen({ kind: "paused_budget", job });

  if (job.state === "queued" || job.state === "waiting_user" || job.state === "paused_budget") {
    const transitioned = await dependencies.jobs.transitionJob(job.jobId, {
      expectedJobVersion: job.jobVersion,
      to: "running",
      atMs: now(dependencies)
    });
    if (transitioned.kind !== "updated") return jobConflict(dependencies, job.jobId);
    job = transitioned.job;
  }
  if (job.state !== "running") return frozen({ kind: "job_conflict", job });

  const current = await dependencies.store.getDraft(job.projectId, job.questId);
  if (!current) return failWithoutUsage(dependencies, job, "starting_snapshot_unavailable");
  const turnKey = sha256(canonicalStringify({
    jobId: job.jobId,
    instruction: input.instruction,
    draftRevision: current.draftRevision,
    draftContentHash: current.contentHash
  }));
  const readOperationId = `read-${turnKey.slice(0, 40)}`;
  const readRequestHash = sha256(canonicalStringify({
    operation: "draft.read",
    projectId: job.projectId,
    questId: job.questId,
    revision: current.draftRevision,
    contentHash: current.contentHash
  }));
  const readReserved = await dependencies.jobs.reserveOperation(job.jobId, {
    expectedJobVersion: job.jobVersion,
    operationId: readOperationId,
    operationKind: "draft.read",
    baseRevision: current.draftRevision,
    requestHash: readRequestHash,
    atMs: now(dependencies)
  });
  if (readReserved.kind === "budget_exhausted") return frozen({ kind: "paused_budget", job: readReserved.job });
  if (readReserved.kind === "job_not_runnable" && readReserved.state === "cancelled") {
    const cancelled = await dependencies.jobs.getJob(job.jobId);
    return cancelled ? frozen({ kind: "cancelled", job: cancelled }) : frozen({ kind: "job_not_found" });
  }
  if (readReserved.kind !== "reserved" && readReserved.kind !== "pending" && readReserved.kind !== "replay") {
    return jobConflict(dependencies, job.jobId);
  }
  job = readReserved.job;

  const snapshot = await dependencies.store.getDraftSnapshot(job.projectId, job.questId, current.draftRevision);
  if (!snapshot || snapshot.contentHash !== current.contentHash) {
    return failWithoutUsage(dependencies, job, "starting_snapshot_unavailable");
  }
  const contextJson = canonicalStringify(snapshot);
  if (contextJson.length > MAX_AUTHOR_CONTEXT_CHARS) return failInvalidOutput(dependencies, job, EMPTY_USAGE, "context_too_large");

  if (readReserved.kind !== "replay") {
    const completed = await dependencies.jobs.completeOperation(job.jobId, {
      operationId: readOperationId,
      requestHash: readRequestHash,
      result: { kind: "read_blocks", blockCount: snapshot.blocks.length },
      activeTimeMs: 0,
      atMs: now(dependencies)
    });
    if (completed.kind !== "completed" && completed.kind !== "replay") return jobConflict(dependencies, job.jobId);
    job = completed.job;
    if (completed.kind === "completed") {
      const checkpointed = await dependencies.jobs.appendCheckpoint(job.jobId, job.jobVersion, {
        kind: "draft.read",
        blockCount: snapshot.blocks.length
      }, now(dependencies));
      if (checkpointed.kind !== "updated") return jobConflict(dependencies, job.jobId);
      job = checkpointed.job;
    }
  }
  if (job.state === "paused_budget") return frozen({ kind: "paused_budget", job });

  const sessionDeadline = now(dependencies) + deadlineMs;
  const opened = await dependencies.backend.openSession({ profileId: dependencies.profileId, deadlineAtMs: sessionDeadline });
  if (!opened.ok) return failBackend(dependencies, job, opened.error.code, EMPTY_USAGE);

  const turn = await dependencies.backend.runTurn({
    session: opened.session,
    messages: [
      {
        role: "system",
        content: "You are an authoring proposal generator. Return ONLY one JSON object with exact keys explanation, changes, missingCapabilities. Never include project/quest/revision/origin, never publish, never change access, never invent unsupported mechanics. If a mechanic is not representable, put it in missingCapabilities and do not fake a block."
      },
      {
        role: "user",
        content: `Instruction:\n${input.instruction}\n\nExact quest draft snapshot:\n${contextJson}`
      }
    ],
    maxOutputTokens: AUTHOR_MAX_OUTPUT_TOKENS,
    deadlineAtMs: sessionDeadline
  });
  if (!turn.ok) {
    await dependencies.backend.closeSession({ session: opened.session, deadlineAtMs: now(dependencies) + deadlineMs });
    return failBackend(dependencies, job, turn.error.code, turn.usage);
  }
  const closed = await dependencies.backend.closeSession({ session: opened.session, deadlineAtMs: now(dependencies) + deadlineMs });
  if (!closed.ok) return failBackend(dependencies, job, closed.error.code, turn.usage);

  const parsed = parseBackendProposalBody(turn.outputText);
  if (!parsed) return failInvalidOutput(dependencies, job, turn.usage, "backend_output_invalid");
  const proposalId = `proposal-${sha256(canonicalStringify({ jobId: job.jobId, turnKey, body: parsed })).slice(0, 40)}`;
  const proposal: AuthoringProposal = deepFreeze({
    proposalId,
    projectId: job.projectId,
    questId: job.questId,
    baseRevision: snapshot.draftRevision,
    baseContentHash: snapshot.contentHash,
    explanation: parsed.explanation,
    changes: parsed.changes.map(cloneJson),
    missingCapabilities: parsed.missingCapabilities.map(cloneJson),
    origin: {
      kind: "assistant",
      backendId: dependencies.backend.safeView.backendId,
      jobId: job.jobId
    }
  });
  const produced = await dependencies.jobs.appendCheckpoint(job.jobId, job.jobVersion, {
    kind: "proposal.produced",
    proposalId
  }, now(dependencies));
  if (produced.kind !== "updated") return jobConflict(dependencies, job.jobId);
  job = produced.job;

  const previewOperationId = `preview-${proposalId.slice("proposal-".length)}`;
  const previewHash = sha256(canonicalStringify({ operation: "proposal.preview", proposal }));
  const previewReserved = await dependencies.jobs.reserveOperation(job.jobId, {
    expectedJobVersion: job.jobVersion,
    operationId: previewOperationId,
    operationKind: "proposal.preview",
    baseRevision: proposal.baseRevision,
    requestHash: previewHash,
    atMs: now(dependencies)
  });
  if (previewReserved.kind === "budget_exhausted") return frozen({ kind: "paused_budget", job: previewReserved.job });
  if (previewReserved.kind !== "reserved" && previewReserved.kind !== "pending" && previewReserved.kind !== "replay") {
    return jobConflict(dependencies, job.jobId);
  }
  job = previewReserved.job;
  const previewResult = await previewAuthoringProposalFromStore(dependencies.store, proposal);
  if (previewResult.kind === "unsupported_store") return failStoreUnavailable(dependencies, job, turn.usage);
  if (previewResult.kind === "invalid_proposal") return failProposalInvalid(dependencies, job, previewResult.errors, turn.usage);
  if (previewResult.kind === "base_snapshot_mismatch") {
    return failProposalConflict(dependencies, job, snapshot.draftRevision, previewResult.actualContentHash, turn.usage);
  }
  if (previewResult.kind === "revision_not_found" || previewResult.kind === "project_not_found" || previewResult.kind === "quest_not_found") {
    return failWithoutUsage(dependencies, job, "starting_snapshot_unavailable", turn.usage);
  }

  const preview = previewResult.preview;
  if (previewReserved.kind !== "replay") {
    const completed = await dependencies.jobs.completeOperation(job.jobId, {
      operationId: previewOperationId,
      requestHash: previewHash,
      result: {
        kind: "proposal_previewed",
        proposalId,
        stale: preview.stale,
        applyAllowed: preview.applyAllowed
      },
      activeTimeMs: 0,
      atMs: now(dependencies)
    });
    if (completed.kind !== "completed" && completed.kind !== "replay") return jobConflict(dependencies, job.jobId);
    job = completed.job;
    if (completed.kind === "completed") {
      const checkpointed = await dependencies.jobs.appendCheckpoint(job.jobId, job.jobVersion, {
        kind: "proposal.previewed",
        proposalId,
        stale: preview.stale,
        applyAllowed: preview.applyAllowed
      }, now(dependencies));
      if (checkpointed.kind !== "updated") return jobConflict(dependencies, job.jobId);
      job = checkpointed.job;
    }
  }
  if (job.state === "paused_budget") return frozen({ kind: "paused_budget", job });

  if (preview.stale) {
    const latest = await dependencies.store.getDraft(job.projectId, job.questId);
    if (!latest) return failWithoutUsage(dependencies, job, "starting_snapshot_unavailable", turn.usage);
    return failProposalConflict(dependencies, job, latest.draftRevision, latest.contentHash, turn.usage);
  }
  if (!input.autoApply || !preview.applyAllowed) {
    const waiting = await dependencies.jobs.transitionJob(job.jobId, {
      expectedJobVersion: job.jobVersion,
      to: "waiting_user",
      atMs: now(dependencies)
    });
    if (waiting.kind !== "updated") return jobConflict(dependencies, job.jobId);
    return frozen({ kind: "proposal_ready", job: waiting.job, proposal, preview, usage: turn.usage });
  }

  const applyOperationId = `apply-${proposalId.slice("proposal-".length)}`;
  const applyHash = sha256(canonicalStringify({ operation: "proposal.apply", proposal }));
  const applyReserved = await dependencies.jobs.reserveOperation(job.jobId, {
    expectedJobVersion: job.jobVersion,
    operationId: applyOperationId,
    operationKind: "proposal.apply",
    baseRevision: proposal.baseRevision,
    requestHash: applyHash,
    atMs: now(dependencies)
  });
  if (applyReserved.kind === "budget_exhausted") return frozen({ kind: "paused_budget", job: applyReserved.job });
  if (applyReserved.kind !== "reserved" && applyReserved.kind !== "pending" && applyReserved.kind !== "replay") {
    return jobConflict(dependencies, job.jobId);
  }
  job = applyReserved.job;

  const applied = await applyAuthoringProposalFromStore(
    dependencies.store,
    proposal,
    `author-${sha256(canonicalStringify({ jobId: job.jobId, proposalId })).slice(0, 48)}`
  );
  if (applied.kind === "unsupported_store") return failStoreUnavailable(dependencies, job, turn.usage);
  if (applied.kind === "invalid_proposal") return failProposalInvalid(dependencies, job, applied.errors, turn.usage);
  if (applied.kind === "revision_conflict") {
    return failProposalConflict(dependencies, job, applied.currentRevision, applied.currentContentHash, turn.usage);
  }
  if (applied.kind === "base_snapshot_mismatch") {
    return failProposalConflict(dependencies, job, applied.revision, applied.actualContentHash, turn.usage);
  }
  if (applied.kind === "missing_capability") {
    const waiting = await dependencies.jobs.transitionJob(job.jobId, {
      expectedJobVersion: job.jobVersion,
      to: "waiting_user",
      atMs: now(dependencies)
    });
    if (waiting.kind !== "updated") return jobConflict(dependencies, job.jobId);
    return frozen({ kind: "proposal_ready", job: waiting.job, proposal, preview, usage: turn.usage });
  }
  if (applied.kind === "project_not_found" || applied.kind === "quest_not_found" || applied.kind === "revision_not_found") {
    return failWithoutUsage(dependencies, job, "starting_snapshot_unavailable", turn.usage);
  }
  if (applied.kind === "idempotency_key_reused" || applied.kind === "invalid_request") {
    return failProposalInvalid(dependencies, job, [applied.kind], turn.usage);
  }

  if (applyReserved.kind !== "replay") {
    const completed = await dependencies.jobs.completeOperation(job.jobId, {
      operationId: applyOperationId,
      requestHash: applyHash,
      result: {
        kind: "proposal_applied",
        proposalId,
        resultRevision: applied.draft.draftRevision,
        resultContentHash: applied.draft.contentHash
      },
      activeTimeMs: 0,
      atMs: now(dependencies)
    });
    if (completed.kind !== "completed" && completed.kind !== "replay") return jobConflict(dependencies, job.jobId);
    job = completed.job;
    if (completed.kind === "completed") {
      const checkpointed = await dependencies.jobs.appendCheckpoint(job.jobId, job.jobVersion, {
        kind: "proposal.applied",
        proposalId,
        resultRevision: applied.draft.draftRevision
      }, now(dependencies));
      if (checkpointed.kind !== "updated") return jobConflict(dependencies, job.jobId);
      job = checkpointed.job;
    }
  }

  if (job.state === "paused_budget") return frozen({ kind: "paused_budget", job });
  const succeeded = await dependencies.jobs.transitionJob(job.jobId, {
    expectedJobVersion: job.jobVersion,
    to: "succeeded",
    atMs: now(dependencies)
  });
  if (succeeded.kind !== "updated") return jobConflict(dependencies, job.jobId);
  return frozen({
    kind: "applied",
    job: succeeded.job,
    proposal,
    preview,
    draft: applied.draft,
    application: applied.application,
    usage: turn.usage
  });
}

interface BackendProposalBody {
  readonly explanation: string;
  readonly changes: readonly DraftChange[];
  readonly missingCapabilities: readonly MissingAuthoringCapability[];
}

function parseBackendProposalBody(text: string): BackendProposalBody | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!isRecord(value) || !hasExactKeys(value, ["explanation", "changes", "missingCapabilities"])) return null;
  if (typeof value.explanation !== "string" || value.explanation.length < 1 || value.explanation.length > 4_000) return null;
  if (!Array.isArray(value.changes) || !Array.isArray(value.missingCapabilities)) return null;
  return deepFreeze({
    explanation: value.explanation,
    changes: value.changes.map(cloneJson) as DraftChange[],
    missingCapabilities: value.missingCapabilities.map(cloneJson) as MissingAuthoringCapability[]
  });
}

async function failBackend(
  dependencies: AuthorAssistantDependencies,
  job: AuthorAgentJobRecord,
  code: AgentBackendErrorCode,
  usage: ProviderUsage
): Promise<RunAuthorAssistantSegmentResult> {
  const failed = await markFailed(dependencies, job, `backend.${code}`);
  return frozen({ kind: "backend_failure", code, job: failed, usage });
}

async function failInvalidOutput(
  dependencies: AuthorAssistantDependencies,
  job: AuthorAgentJobRecord,
  usage: ProviderUsage,
  code: string
): Promise<RunAuthorAssistantSegmentResult> {
  const failed = await markFailed(dependencies, job, code);
  return frozen({ kind: "invalid_backend_output", job: failed, usage });
}

async function failProposalInvalid(
  dependencies: AuthorAssistantDependencies,
  job: AuthorAgentJobRecord,
  details: readonly string[],
  usage: ProviderUsage
): Promise<RunAuthorAssistantSegmentResult> {
  const failed = await markFailed(dependencies, job, "proposal.invalid");
  return frozen({ kind: "proposal_invalid", job: failed, details: Object.freeze([...details]), usage });
}

async function failProposalConflict(
  dependencies: AuthorAssistantDependencies,
  job: AuthorAgentJobRecord,
  currentRevision: number,
  currentContentHash: string,
  usage: ProviderUsage
): Promise<RunAuthorAssistantSegmentResult> {
  const failed = await markFailed(dependencies, job, "proposal.stale");
  return frozen({ kind: "proposal_base_conflict", job: failed, currentRevision, currentContentHash, usage });
}

async function failStoreUnavailable(
  dependencies: AuthorAssistantDependencies,
  job: AuthorAgentJobRecord,
  usage: ProviderUsage
): Promise<RunAuthorAssistantSegmentResult> {
  const failed = await markFailed(dependencies, job, "proposal.store_unavailable");
  return frozen({ kind: "store_unavailable", job: failed, usage });
}

async function failWithoutUsage(
  dependencies: AuthorAssistantDependencies,
  job: AuthorAgentJobRecord,
  kind: "starting_snapshot_unavailable",
  usage: ProviderUsage = EMPTY_USAGE
): Promise<RunAuthorAssistantSegmentResult> {
  const failed = await markFailed(dependencies, job, kind);
  return frozen({ kind, job: failed });
}

async function markFailed(
  dependencies: AuthorAssistantDependencies,
  job: AuthorAgentJobRecord,
  code: string
): Promise<AuthorAgentJobRecord> {
  const latest = await dependencies.jobs.getJob(job.jobId) ?? job;
  if (latest.state === "failed" || latest.state === "cancelled" || latest.state === "succeeded") return latest;
  const result = await dependencies.jobs.transitionJob(latest.jobId, {
    expectedJobVersion: latest.jobVersion,
    to: "failed",
    failureCode: sanitizeFailureCode(code),
    atMs: now(dependencies)
  });
  return result.kind === "updated" ? result.job : (await dependencies.jobs.getJob(job.jobId) ?? latest);
}

async function jobConflict(
  dependencies: AuthorAssistantDependencies,
  jobId: string
): Promise<RunAuthorAssistantSegmentResult> {
  const job = await dependencies.jobs.getJob(jobId);
  return job ? frozen({ kind: "job_conflict", job }) : frozen({ kind: "job_not_found" });
}

function sanitizeFailureCode(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 200);
  return normalized.length > 0 && /^[A-Za-z0-9]/.test(normalized) ? normalized : "author.failure";
}

function normalizedDeadlineMs(value: number | undefined): number | null {
  const resolved = value ?? DEFAULT_AUTHOR_BACKEND_DEADLINE_MS;
  return Number.isSafeInteger(resolved) && resolved >= 1 && resolved <= MAX_AUTHOR_BACKEND_DEADLINE_MS ? resolved : null;
}

function now(dependencies: AuthorAssistantDependencies): number {
  const value = (dependencies.nowMs ?? (() => Date.now()))();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid author assistant clock");
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, any>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

const EMPTY_USAGE: ProviderUsage = Object.freeze({ inputTokens: null, outputTokens: null, totalTokens: null });
