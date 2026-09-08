// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
import { createHash } from "node:crypto";
import {
  CORE_ONLY_AUTHOR_CONTEXT_CAPABILITY_CATALOG,
  applyAuthoringProposalFromStore,
  authorizeAuthorToolBrokerRequest,
  buildAuthorContextBundle,
  ensureAuthorToolBrokerPin,
  previewAuthoringProposalFromStore,
  type AuthorAgentJobRecord,
  type AuthorAgentJobStore,
  type AuthorAgentOperationKind,
  type AuthorAgentProposalArtifactStore,
  type AuthorContextCapabilityCatalog,
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
import { loadInstalledAgentKit } from "./agent-kit.js";
import { AUTHOR_OUTPUT_CONTRACT } from "./author-output-contract.js";
import type { AuthorMcpClient } from "./author-mcp.js";
import { AUTHOR_REFERENCE_TOOL_PROTOCOL_INSTRUCTION, runAuthorBackendToolProtocol } from "./author-backend-tool-protocol.js";

const MAX_AUTHOR_INSTRUCTION_CHARS = 20_000;
const MAX_AUTHOR_CONTEXT_CHARS = 64_000;
const DEFAULT_AUTHOR_BACKEND_DEADLINE_MS = 60_000;
const MAX_AUTHOR_BACKEND_DEADLINE_MS = 120_000;
const AUTHOR_MAX_OUTPUT_TOKENS = 8_192;

export interface AuthorAssistantDependencies {
  readonly store: ControlStore;
  readonly jobs: AuthorAgentJobStore;
  readonly artifacts: AuthorAgentProposalArtifactStore;
  readonly backend: AgentBackend;
  readonly profileId: string;
  readonly capabilityCatalog?: AuthorContextCapabilityCatalog;
  readonly referenceMcpClient?: AuthorMcpClient;
  readonly nowMs?: () => number;
  readonly backendDeadlineMs?: number;
  /** Explicit local author mode: complete small quest or fail before an API call. */
  readonly contextScope?: "entry" | "small_quest";
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
  readonly signal?: AbortSignal;
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
  | { readonly kind: "job_conflict"; readonly job: AuthorAgentJobRecord }
  | { readonly kind: "broker_failure"; readonly code: "contract_changed" | "invalid_pin" | "operation_denied"; readonly job: AuthorAgentJobRecord };

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
  const allowedOperations: readonly AuthorAgentOperationKind[] = dependencies.referenceMcpClient
    ? Object.freeze(["draft.read", "proposal.preview", "proposal.apply", "docs.reference.read"] as const)
    : Object.freeze(["draft.read", "proposal.preview", "proposal.apply"] as const);
  const result = await dependencies.jobs.createJob({
    jobId: input.jobId,
    projectId: input.projectId,
    questId: input.questId,
    ownerUserId: input.ownerUserId,
    startingDraftRevision: draft.draftRevision,
    startingDraftContentHash: draft.contentHash,
    backendId: dependencies.backend.safeView.backendId,
    allowedOperations,
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
  if (dependencies.contextScope === "small_quest" && snapshot.blocks.length > 32) {
    return failInvalidOutput(dependencies, job, EMPTY_USAGE, "context_too_large");
  }
  const contextResult = buildAuthorContextBundle(
    snapshot,
    dependencies.contextScope === "small_quest" ? snapshot.blocks.map((block) => block.id) : [snapshot.entryLocationId],
    dependencies.capabilityCatalog ?? CORE_ONLY_AUTHOR_CONTEXT_CAPABILITY_CATALOG
  );
  if (contextResult.kind !== "built") {
    return failInvalidOutput(dependencies, job, EMPTY_USAGE, `context_${contextResult.code}`);
  }
  const contextBundle = contextResult.bundle;
  const contextJson = canonicalStringify(contextBundle);
  const contextHash = sha256(contextJson);
  if (contextJson.length > MAX_AUTHOR_CONTEXT_CHARS) return failInvalidOutput(dependencies, job, EMPTY_USAGE, "context_too_large");

  if (readReserved.kind !== "replay") {
    const completed = await dependencies.jobs.completeOperation(job.jobId, {
      operationId: readOperationId,
      requestHash: readRequestHash,
      result: { kind: "read_blocks", blockCount: contextBundle.blocks.length },
      activeTimeMs: 0,
      atMs: now(dependencies)
    });
    if (completed.kind !== "completed" && completed.kind !== "replay") return jobConflict(dependencies, job.jobId);
    job = completed.job;
    if (completed.kind === "completed") {
      const checkpointed = await dependencies.jobs.appendCheckpoint(job.jobId, job.jobVersion, {
        kind: "draft.read",
        blockCount: contextBundle.blocks.length
      }, now(dependencies));
      if (checkpointed.kind !== "updated") return jobConflict(dependencies, job.jobId);
      job = checkpointed.job;
    }
  }
  const contextCheckpoints = await dependencies.jobs.listCheckpoints(job.jobId);
  if (!contextCheckpoints) return frozen({ kind: "job_not_found" });
  if (!contextCheckpoints.some((entry) => entry.fact.kind === "context.selected"
    && entry.fact.draftRevision === snapshot.draftRevision
    && entry.fact.contextHash === contextHash)) {
    const contextCheckpointed = await dependencies.jobs.appendCheckpoint(job.jobId, job.jobVersion, {
      kind: "context.selected",
      draftRevision: snapshot.draftRevision,
      draftContentHash: snapshot.contentHash,
      contextHash,
      selectedBlockIds: contextBundle.selectedBlockIds,
      includedBlockIds: contextBundle.includedBlockIds
    }, now(dependencies));
    if (contextCheckpointed.kind !== "updated") return jobConflict(dependencies, job.jobId);
    job = contextCheckpointed.job;
  }
  if (job.state === "paused_budget") return frozen({ kind: "paused_budget", job });

  let proposal: AuthoringProposal;
  let usage: ProviderUsage;
  const persistedArtifact = await dependencies.artifacts.getProposalArtifact(job.jobId, turnKey);
  if (persistedArtifact) {
    if (persistedArtifact.proposal.projectId !== job.projectId
      || persistedArtifact.proposal.questId !== job.questId
      || persistedArtifact.proposal.baseRevision !== snapshot.draftRevision
      || persistedArtifact.proposal.baseContentHash !== snapshot.contentHash
      || persistedArtifact.proposal.origin.backendId !== dependencies.backend.safeView.backendId) {
      return failInvalidOutput(dependencies, job, EMPTY_USAGE, "proposal_artifact_mismatch");
    }
    proposal = persistedArtifact.proposal;
    usage = persistedArtifact.usage;
  } else {
    const sessionDeadline = now(dependencies) + deadlineMs;
    const opened = await dependencies.backend.openSession({
      profileId: dependencies.profileId,
      deadlineAtMs: sessionDeadline,
      ...(input.signal ? { signal: input.signal } : {})
    });
    if (!opened.ok) {
      if (opened.error.code === "aborted") {
        const cancelled = await cancelledJob(dependencies, job.jobId);
        if (cancelled) return frozen({ kind: "cancelled", job: cancelled });
      }
      return failBackend(dependencies, job, opened.error.code, EMPTY_USAGE);
    }

    const systemInstruction = "You are an authoring proposal generator. Return ONLY one JSON object with exact keys explanation, changes, missingCapabilities. Never include project/quest/revision/origin, never publish, never change access, never invent unsupported mechanics. The supplied authoring context is intentionally bounded; omitted blocks may still exist, so never infer their absence. If a mechanic is not representable by the supplied installed capability catalog, put it in missingCapabilities and do not fake a block."
      + `\n${AUTHOR_OUTPUT_CONTRACT}`
      + (dependencies.referenceMcpClient ? ` ${AUTHOR_REFERENCE_TOOL_PROTOCOL_INSTRUCTION}` : "");
    const backendLoop = await runAuthorBackendToolProtocol({
      backend: dependencies.backend,
      session: opened.session,
      messages: Object.freeze([
        Object.freeze({ role: "system" as const, content: systemInstruction }),
        Object.freeze({
          role: "user" as const,
          content: `Instruction:\n${input.instruction}\n\nBounded quest authoring context:\n${contextJson}`
        })
      ]),
      maxOutputTokens: AUTHOR_MAX_OUTPUT_TOKENS,
      deadlineAtMs: sessionDeadline,
      job,
      jobs: dependencies.jobs,
      turnKey,
      referenceMcpClient: dependencies.referenceMcpClient ?? null,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(dependencies.nowMs ? { nowMs: dependencies.nowMs } : {})
    });
    if (backendLoop.kind !== "completed") {
      await dependencies.backend.closeSession({ session: opened.session, deadlineAtMs: now(dependencies) + deadlineMs });
      if (backendLoop.kind === "paused_budget") return frozen({ kind: "paused_budget", job: backendLoop.job });
      if (backendLoop.kind === "cancelled") return frozen({ kind: "cancelled", job: backendLoop.job });
      if (backendLoop.kind === "broker_failure") return failBroker(dependencies, backendLoop.job, "operation_denied");
      if (backendLoop.kind === "invalid_output") return failInvalidOutput(dependencies, backendLoop.job, backendLoop.usage, backendLoop.code);
      if (backendLoop.code === "aborted") {
        const cancelled = await cancelledJob(dependencies, backendLoop.job.jobId);
        if (cancelled) return frozen({ kind: "cancelled", job: cancelled });
      }
      return failBackend(dependencies, backendLoop.job, backendLoop.code, backendLoop.usage);
    }
    job = backendLoop.job;
    const turn = { outputText: backendLoop.outputText, usage: backendLoop.usage };
    const closed = await dependencies.backend.closeSession({ session: opened.session, deadlineAtMs: now(dependencies) + deadlineMs });
    if (!closed.ok) return failBackend(dependencies, job, closed.error.code, turn.usage);
    if (input.signal?.aborted) {
      const cancelled = await cancelledJob(dependencies, job.jobId);
      if (cancelled) return frozen({ kind: "cancelled", job: cancelled });
      return failBackend(dependencies, job, "aborted", turn.usage);
    }
    const cancelledAfterTurn = await cancelledJob(dependencies, job.jobId);
    if (cancelledAfterTurn) return frozen({ kind: "cancelled", job: cancelledAfterTurn });

    const parsed = parseBackendProposalBody(turn.outputText);
    if (!parsed) return failInvalidOutput(dependencies, job, turn.usage, "backend_output_invalid");
    const proposalId = `proposal-${sha256(canonicalStringify({ jobId: job.jobId, turnKey, body: parsed })).slice(0, 40)}`;
    const generatedProposal: AuthoringProposal = deepFreeze({
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
    const saved = await dependencies.artifacts.saveProposalArtifact(job.jobId, {
      turnKey,
      proposal: generatedProposal,
      usage: turn.usage,
      createdAtMs: now(dependencies)
    });
    if (saved.kind === "job_not_found" || saved.kind === "invalid_request") return jobConflict(dependencies, job.jobId);
    if (saved.kind === "turn_key_reused") {
      const canonicalArtifact = await dependencies.artifacts.getProposalArtifact(job.jobId, turnKey);
      if (!canonicalArtifact) return jobConflict(dependencies, job.jobId);
      proposal = canonicalArtifact.proposal;
      usage = canonicalArtifact.usage;
    } else {
      proposal = saved.artifact.proposal;
      usage = saved.artifact.usage;
    }
  }

  const checkpoints = await dependencies.jobs.listCheckpoints(job.jobId);
  if (!checkpoints) return frozen({ kind: "job_not_found" });
  if (!checkpoints.some((entry) => entry.fact.kind === "proposal.produced" && entry.fact.proposalId === proposal.proposalId)) {
    const produced = await dependencies.jobs.appendCheckpoint(job.jobId, job.jobVersion, {
      kind: "proposal.produced",
      proposalId: proposal.proposalId
    }, now(dependencies));
    if (produced.kind !== "updated") return jobConflict(dependencies, job.jobId);
    job = produced.job;
  }

  if (authorizeAuthorToolBrokerRequest(brokerPin, job, {
    toolId: "author.proposal.preview", source: "builtin"
  }).kind !== "allowed") return failBroker(dependencies, job, "operation_denied");
  const previewOperationId = `preview-${proposal.proposalId.slice("proposal-".length)}`;
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
  if (previewResult.kind === "unsupported_store") return failStoreUnavailable(dependencies, job, usage);
  if (previewResult.kind === "invalid_proposal") return failProposalInvalid(dependencies, job, previewResult.errors, usage);
  if (previewResult.kind === "base_snapshot_mismatch") {
    return failProposalConflict(dependencies, job, snapshot.draftRevision, previewResult.actualContentHash, usage);
  }
  if (previewResult.kind === "revision_not_found" || previewResult.kind === "project_not_found" || previewResult.kind === "quest_not_found") {
    return failWithoutUsage(dependencies, job, "starting_snapshot_unavailable", usage);
  }

  const preview = previewResult.preview;
  if (previewReserved.kind !== "replay") {
    const completed = await dependencies.jobs.completeOperation(job.jobId, {
      operationId: previewOperationId,
      requestHash: previewHash,
      result: {
        kind: "proposal_previewed",
        proposalId: proposal.proposalId,
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
        proposalId: proposal.proposalId,
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
    if (!latest) return failWithoutUsage(dependencies, job, "starting_snapshot_unavailable", usage);
    return failProposalConflict(dependencies, job, latest.draftRevision, latest.contentHash, usage);
  }
  if (!input.autoApply || !preview.applyAllowed) {
    const waiting = await dependencies.jobs.transitionJob(job.jobId, {
      expectedJobVersion: job.jobVersion,
      to: "waiting_user",
      atMs: now(dependencies)
    });
    if (waiting.kind !== "updated") return jobConflict(dependencies, job.jobId);
    return frozen({ kind: "proposal_ready", job: waiting.job, proposal, preview, usage: usage });
  }

  if (authorizeAuthorToolBrokerRequest(brokerPin, job, {
    toolId: "author.proposal.apply", source: "builtin"
  }).kind !== "allowed") return failBroker(dependencies, job, "operation_denied");
  const applyOperationId = `apply-${proposal.proposalId.slice("proposal-".length)}`;
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
    `author-${sha256(canonicalStringify({ jobId: job.jobId, proposalId: proposal.proposalId })).slice(0, 48)}`
  );
  if (applied.kind === "unsupported_store") return failStoreUnavailable(dependencies, job, usage);
  if (applied.kind === "invalid_proposal") return failProposalInvalid(dependencies, job, applied.errors, usage);
  if (applied.kind === "revision_conflict") {
    return failProposalConflict(dependencies, job, applied.currentRevision, applied.currentContentHash, usage);
  }
  if (applied.kind === "base_snapshot_mismatch") {
    return failProposalConflict(dependencies, job, applied.revision, applied.actualContentHash, usage);
  }
  if (applied.kind === "missing_capability") {
    const waiting = await dependencies.jobs.transitionJob(job.jobId, {
      expectedJobVersion: job.jobVersion,
      to: "waiting_user",
      atMs: now(dependencies)
    });
    if (waiting.kind !== "updated") return jobConflict(dependencies, job.jobId);
    return frozen({ kind: "proposal_ready", job: waiting.job, proposal, preview, usage: usage });
  }
  if (applied.kind === "project_not_found" || applied.kind === "quest_not_found" || applied.kind === "revision_not_found") {
    return failWithoutUsage(dependencies, job, "starting_snapshot_unavailable", usage);
  }
  if (applied.kind === "idempotency_key_reused" || applied.kind === "invalid_request") {
    return failProposalInvalid(dependencies, job, [applied.kind], usage);
  }

  if (applyReserved.kind !== "replay") {
    const completed = await dependencies.jobs.completeOperation(job.jobId, {
      operationId: applyOperationId,
      requestHash: applyHash,
      result: {
        kind: "proposal_applied",
        proposalId: proposal.proposalId,
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
        proposalId: proposal.proposalId,
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
    usage: usage
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

async function failBroker(
  dependencies: AuthorAssistantDependencies,
  job: AuthorAgentJobRecord,
  code: "contract_changed" | "invalid_pin" | "operation_denied"
): Promise<RunAuthorAssistantSegmentResult> {
  const failed = await markFailed(dependencies, job, `broker.${code}`);
  return frozen({ kind: "broker_failure", code, job: failed });
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

async function cancelledJob(
  dependencies: AuthorAssistantDependencies,
  jobId: string
): Promise<AuthorAgentJobRecord | null> {
  const latest = await dependencies.jobs.getJob(jobId);
  return latest?.state === "cancelled" ? latest : null;
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
