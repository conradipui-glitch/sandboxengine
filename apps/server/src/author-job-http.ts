// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
import { createHash } from "node:crypto";
import {
  DEFAULT_AUTHOR_AGENT_MAX_ACTIVE_TIME_MS,
  DEFAULT_AUTHOR_AGENT_MAX_TOOL_CALLS,
  applyAuthoringProposalFromStore,
  type AuthorAgentJobRecord,
  type AuthorConversationStore,
  type ControlProjectRole
} from "@living-history/control";
import { canonicalStringify } from "@living-history/core";
import {
  createAuthorAssistantJob,
  runAuthorAssistantSegment,
  type AuthorAssistantDependencies,
  type RunAuthorAssistantSegmentResult
} from "./author-assistant.js";

export interface AuthorJobHttpContext {
  readonly method: string;
  readonly url: URL;
  readonly authorAssistant: AuthorAssistantDependencies | null;
  readonly authorConversation: AuthorConversationStore | null;
  readonly actorUserId: string;
  readonly requireRole: (projectId: string, role: ControlProjectRole) => Promise<boolean>;
  readonly requireMutation: () => Promise<boolean>;
  readonly requireIdempotencyKey: () => string | null;
  readonly requireJsonObject: () => Promise<Record<string, any> | null>;
  readonly sendJson: (status: number, body: unknown) => void;
  readonly sendNotFound: () => void;
}

export async function routeAuthorJobHttp(context: AuthorJobHttpContext): Promise<boolean> {
  const collection = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/author\/jobs$/.exec(context.url.pathname);
  if (collection) {
    const projectId = collection[1];
    const questId = collection[2];
    if (!projectId || !questId || (context.authorAssistant === null || context.authorConversation === null)) { context.sendNotFound(); return true; }
    if (!(await context.requireRole(projectId, "editor"))) return true;
    if (!hasExactQuery(context.url.searchParams, [])) {
      context.sendJson(400, { error: { code: "INVALID_AUTHOR_JOB_REQUEST" } });
      return true;
    }
    if (context.method === "GET") {
      const jobs = await context.authorAssistant.jobs.listJobs(projectId, questId, context.actorUserId);
      context.sendJson(200, { jobs });
      return true;
    }
    if (context.method !== "POST") { context.sendNotFound(); return true; }
    if (!(await context.requireMutation())) return true;
    const idempotencyKey = context.requireIdempotencyKey();
    if (idempotencyKey === null) return true;
    const body = await context.requireJsonObject();
    if (body === null) return true;
    if (!isCreateBody(body)) {
      context.sendJson(400, { error: { code: "INVALID_AUTHOR_JOB_REQUEST" } });
      return true;
    }
    const jobId = derivedId("author-job", { projectId, questId, actorUserId: context.actorUserId, idempotencyKey });
    const created = await createAuthorAssistantJob(context.authorAssistant, {
      jobId,
      projectId,
      questId,
      ownerUserId: context.actorUserId,
      ...(body.maxToolCalls === undefined ? {} : { maxToolCalls: body.maxToolCalls }),
      ...(body.maxActiveTimeMs === undefined ? {} : { maxActiveTimeMs: body.maxActiveTimeMs })
    });
    if (created.kind === "created") {
      context.sendJson(201, { job: created.job });
      return true;
    }
    if (created.kind === "project_or_quest_not_found") { context.sendNotFound(); return true; }
    if (created.kind === "invalid_request") {
      context.sendJson(400, { error: { code: "INVALID_AUTHOR_JOB_REQUEST" } });
      return true;
    }
    const existing = await context.authorAssistant.jobs.getJob(jobId);
    if (!existing || !sameCreateRequest(existing, context.authorAssistant, projectId, questId, context.actorUserId, body)) {
      context.sendJson(409, { error: { code: "IDEMPOTENCY_KEY_REUSED" } });
      return true;
    }
    context.sendJson(200, { job: existing, replay: true });
    return true;
  }

  const item = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/author\/jobs\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})$/.exec(context.url.pathname);
  if (item) {
    if (context.method !== "GET") { context.sendNotFound(); return true; }
    const projectId = item[1];
    const questId = item[2];
    const jobId = item[3];
    if (!projectId || !questId || !jobId || (context.authorAssistant === null || context.authorConversation === null)) { context.sendNotFound(); return true; }
    if (!(await context.requireRole(projectId, "editor"))) return true;
    if (!hasExactQuery(context.url.searchParams, [])) {
      context.sendJson(400, { error: { code: "INVALID_AUTHOR_JOB_REQUEST" } });
      return true;
    }
    const job = await ownedJob(context.authorAssistant, projectId, questId, jobId, context.actorUserId);
    if (!job) { context.sendNotFound(); return true; }
    const checkpoints = await context.authorAssistant.jobs.listCheckpoints(jobId);
    const messages = await context.authorConversation.listMessages(jobId);
    if (!checkpoints || !messages) { context.sendNotFound(); return true; }
    const proposalArtifacts = [];
    const seenTurnKeys = new Set();
    for (const message of messages) {
      if (message.proposalTurnKey === null || seenTurnKeys.has(message.proposalTurnKey)) continue;
      const artifact = await context.authorAssistant.artifacts.getProposalArtifact(jobId, message.proposalTurnKey);
      if (!artifact || artifact.proposal.proposalId !== message.proposalId) {
        context.sendJson(500, { error: { code: "AUTHOR_CONVERSATION_ARTIFACT_MISSING" } });
        return true;
      }
      seenTurnKeys.add(message.proposalTurnKey);
      proposalArtifacts.push(artifact);
    }
    context.sendJson(200, { job, checkpoints, messages, proposalArtifacts });
    return true;
  }

  const segment = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/author\/jobs\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/segments$/.exec(context.url.pathname);
  if (segment) {
    if (context.method !== "POST") { context.sendNotFound(); return true; }
    const projectId = segment[1];
    const questId = segment[2];
    const jobId = segment[3];
    if (!projectId || !questId || !jobId || (context.authorAssistant === null || context.authorConversation === null)) { context.sendNotFound(); return true; }
    if (!(await context.requireRole(projectId, "editor"))) return true;
    if (!hasExactQuery(context.url.searchParams, [])) {
      context.sendJson(400, { error: { code: "INVALID_AUTHOR_SEGMENT_REQUEST" } });
      return true;
    }
    if (!(await context.requireMutation())) return true;
    const idempotencyKey = context.requireIdempotencyKey();
    if (idempotencyKey === null) return true;
    const body = await context.requireJsonObject();
    if (body === null) return true;
    if (!isSegmentBody(body)) {
      context.sendJson(400, { error: { code: "INVALID_AUTHOR_SEGMENT_REQUEST" } });
      return true;
    }
    let job = await ownedJob(context.authorAssistant, projectId, questId, jobId, context.actorUserId);
    if (!job) { context.sendNotFound(); return true; }

    const requestId = derivedId("segment", { jobId, idempotencyKey });
    const requestHash = sha256(canonicalStringify({ instruction: body.instruction, resumeBudget: body.resumeBudget ?? false }));
    const checkpoints = await context.authorAssistant.jobs.listCheckpoints(jobId);
    if (!checkpoints) { context.sendNotFound(); return true; }
    const previous = checkpoints.find((entry) => entry.fact.kind === "segment.requested" && entry.fact.requestId === requestId);
    if (previous && previous.fact.kind === "segment.requested" && previous.fact.requestHash !== requestHash) {
      context.sendJson(409, { error: { code: "IDEMPOTENCY_KEY_REUSED" } });
      return true;
    }
    if (!previous) {
      const checkpointed = await context.authorAssistant.jobs.appendCheckpoint(jobId, job.jobVersion, {
        kind: "segment.requested",
        requestId,
        requestHash
      }, now(context.authorAssistant));
      if (checkpointed.kind === "job_version_conflict") {
        context.sendJson(409, { error: { code: "AUTHOR_JOB_CONFLICT", currentJobVersion: checkpointed.currentJobVersion } });
        return true;
      }
      if (checkpointed.kind !== "updated") {
        context.sendJson(409, { error: { code: "AUTHOR_JOB_NOT_RUNNABLE" } });
        return true;
      }
      job = checkpointed.job;
    }

    const authorMessage = await context.authorConversation.appendMessage(jobId, {
      messageId: `author-msg-${requestId.slice("segment-".length)}`,
      role: "author",
      text: body.instruction,
      proposalId: null,
      proposalTurnKey: null,
      createdAtMs: now(context.authorAssistant)
    });
    if (authorMessage.kind === "message_id_reused") {
      context.sendJson(409, { error: { code: "IDEMPOTENCY_KEY_REUSED" } });
      return true;
    }
    if (authorMessage.kind !== "appended" && authorMessage.kind !== "replay") {
      context.sendJson(409, { error: { code: "AUTHOR_CONVERSATION_UNAVAILABLE" } });
      return true;
    }

    const result = await runAuthorAssistantSegment(context.authorAssistant, {
      jobId,
      instruction: body.instruction,
      autoApply: false,
      ...(body.resumeBudget === true ? { resumeBudget: true } : {})
    });
    if (result.kind === "proposal_ready") {
      const proposalTurnKey = sha256(canonicalStringify({
        jobId,
        instruction: body.instruction,
        draftRevision: result.proposal.baseRevision,
        draftContentHash: result.proposal.baseContentHash
      }));
      const assistantMessage = await context.authorConversation.appendMessage(jobId, {
        messageId: `assistant-msg-${requestId.slice("segment-".length)}`,
        role: "assistant",
        text: result.proposal.explanation,
        proposalId: result.proposal.proposalId,
        proposalTurnKey,
        createdAtMs: now(context.authorAssistant)
      });
      if (assistantMessage.kind === "message_id_reused") {
        context.sendJson(409, { error: { code: "AUTHOR_CONVERSATION_CONFLICT" } });
        return true;
      }
      if (assistantMessage.kind !== "appended" && assistantMessage.kind !== "replay") {
        context.sendJson(409, { error: { code: "AUTHOR_CONVERSATION_UNAVAILABLE" } });
        return true;
      }
    }
    sendSegmentResult(context, result);
    return true;
  }

  const proposalApply = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/author\/jobs\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/proposals\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/apply$/.exec(context.url.pathname);
  if (proposalApply) {
    if (context.method !== "POST") { context.sendNotFound(); return true; }
    const projectId = proposalApply[1];
    const questId = proposalApply[2];
    const jobId = proposalApply[3];
    const proposalId = proposalApply[4];
    if (!projectId || !questId || !jobId || !proposalId || (context.authorAssistant === null || context.authorConversation === null)) {
      context.sendNotFound();
      return true;
    }
    if (!(await context.requireRole(projectId, "editor"))) return true;
    if (!hasExactQuery(context.url.searchParams, [])) {
      context.sendJson(400, { error: { code: "INVALID_AUTHOR_PROPOSAL_APPLY_REQUEST" } });
      return true;
    }
    if (!(await context.requireMutation())) return true;
    const idempotencyKey = context.requireIdempotencyKey();
    if (idempotencyKey === null) return true;
    const body = await context.requireJsonObject();
    if (body === null) return true;
    if (!hasExactKeys(body, [])) {
      context.sendJson(400, { error: { code: "INVALID_AUTHOR_PROPOSAL_APPLY_REQUEST" } });
      return true;
    }

    const job = await ownedJob(context.authorAssistant, projectId, questId, jobId, context.actorUserId);
    if (!job) { context.sendNotFound(); return true; }
    if (job.state !== "waiting_user" && job.state !== "paused_budget") {
      context.sendJson(409, { error: { code: "AUTHOR_JOB_NOT_WAITING", state: job.state } });
      return true;
    }

    const messages = await context.authorConversation.listMessages(jobId);
    if (!messages) { context.sendNotFound(); return true; }
    const proposalMessage = [...messages].reverse().find((message) =>
      message.role === "assistant" && message.proposalId === proposalId && message.proposalTurnKey !== null
    );
    if (!proposalMessage || proposalMessage.proposalTurnKey === null) { context.sendNotFound(); return true; }
    const artifact = await context.authorAssistant.artifacts.getProposalArtifact(jobId, proposalMessage.proposalTurnKey);
    const proposal = artifact?.proposal;
    if (!artifact || !proposal
      || proposal.proposalId !== proposalId
      || proposal.projectId !== projectId
      || proposal.questId !== questId
      || proposal.origin.kind !== "assistant"
      || proposal.origin.jobId !== jobId
      || proposal.origin.backendId !== job.backendId) {
      context.sendJson(409, { error: { code: "AUTHOR_PROPOSAL_ARTIFACT_MISMATCH" } });
      return true;
    }

    const applied = await applyAuthoringProposalFromStore(context.authorAssistant.store, proposal, idempotencyKey);
    if (applied.kind === "applied" || applied.kind === "replay") {
      const checkpointed = await ensureAppliedCheckpoint(
        context.authorAssistant,
        jobId,
        proposalId,
        applied.draft.draftRevision
      );
      if (!checkpointed) {
        context.sendJson(503, {
          error: { code: "AUTHOR_APPLY_AUDIT_PENDING", committed: true },
          draft: applied.draft,
          application: applied.application,
          ...(applied.kind === "replay" ? { replay: true } : {})
        });
        return true;
      }
      context.sendJson(applied.kind === "applied" ? 201 : 200, {
        draft: applied.draft,
        application: applied.application,
        ...(applied.kind === "replay" ? { replay: true } : {})
      });
      return true;
    }
    if (applied.kind === "project_not_found" || applied.kind === "quest_not_found") { context.sendNotFound(); return true; }
    if (applied.kind === "revision_not_found") {
      context.sendJson(404, { error: { code: "DRAFT_REVISION_NOT_FOUND", revision: applied.revision } });
      return true;
    }
    if (applied.kind === "base_snapshot_mismatch") {
      context.sendJson(409, {
        error: {
          code: "AUTHORING_PROPOSAL_BASE_SNAPSHOT_MISMATCH",
          revision: applied.revision,
          actualContentHash: applied.actualContentHash
        }
      });
      return true;
    }
    if (applied.kind === "revision_conflict") {
      context.sendJson(409, {
        error: { code: "DRAFT_REVISION_CONFLICT", currentRevision: applied.currentRevision, currentContentHash: applied.currentContentHash }
      });
      return true;
    }
    if (applied.kind === "missing_capability") {
      context.sendJson(422, {
        error: { code: "AUTHORING_PROPOSAL_MISSING_CAPABILITY", missingCapabilities: applied.missingCapabilities }
      });
      return true;
    }
    if (applied.kind === "idempotency_key_reused") {
      context.sendJson(409, { error: { code: "IDEMPOTENCY_KEY_REUSED" } });
      return true;
    }
    if (applied.kind === "unsupported_store") {
      context.sendJson(500, { error: { code: "CONTROL_AUTHORING_PROPOSAL_STORE_UNAVAILABLE" } });
      return true;
    }
    if (applied.kind === "invalid_request") {
      context.sendJson(400, { error: { code: "INVALID_AUTHOR_PROPOSAL_APPLY_REQUEST" } });
      return true;
    }
    context.sendJson(422, { error: { code: "INVALID_AUTHORING_PROPOSAL", details: applied.errors } });
    return true;
  }

  const cancel = /^\/control\/v1\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/quests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/author\/jobs\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/cancel$/.exec(context.url.pathname);
  if (cancel) {
    if (context.method !== "POST") { context.sendNotFound(); return true; }
    const projectId = cancel[1];
    const questId = cancel[2];
    const jobId = cancel[3];
    if (!projectId || !questId || !jobId || (context.authorAssistant === null || context.authorConversation === null)) { context.sendNotFound(); return true; }
    if (!(await context.requireRole(projectId, "editor"))) return true;
    if (!hasExactQuery(context.url.searchParams, [])) {
      context.sendJson(400, { error: { code: "INVALID_AUTHOR_CANCEL_REQUEST" } });
      return true;
    }
    if (!(await context.requireMutation())) return true;
    if (context.requireIdempotencyKey() === null) return true;
    const body = await context.requireJsonObject();
    if (body === null) return true;
    if (!hasExactKeys(body, [])) {
      context.sendJson(400, { error: { code: "INVALID_AUTHOR_CANCEL_REQUEST" } });
      return true;
    }
    const job = await ownedJob(context.authorAssistant, projectId, questId, jobId, context.actorUserId);
    if (!job) { context.sendNotFound(); return true; }
    if (job.state === "cancelled") {
      context.sendJson(200, { job, replay: true });
      return true;
    }
    if (job.state === "succeeded" || job.state === "failed") {
      context.sendJson(409, { error: { code: "AUTHOR_JOB_TERMINAL", state: job.state } });
      return true;
    }
    const result = await context.authorAssistant.jobs.transitionJob(jobId, {
      expectedJobVersion: job.jobVersion,
      to: "cancelled",
      atMs: now(context.authorAssistant)
    });
    if (result.kind === "updated") context.sendJson(200, { job: result.job });
    else if (result.kind === "job_version_conflict") {
      context.sendJson(409, { error: { code: "AUTHOR_JOB_CONFLICT", currentJobVersion: result.currentJobVersion } });
    } else context.sendJson(409, { error: { code: "AUTHOR_JOB_NOT_RUNNABLE" } });
    return true;
  }

  return false;
}

async function ensureAppliedCheckpoint(
  dependencies: AuthorAssistantDependencies,
  jobId: string,
  proposalId: string,
  resultRevision: number
): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const [job, checkpoints] = await Promise.all([
      dependencies.jobs.getJob(jobId),
      dependencies.jobs.listCheckpoints(jobId)
    ]);
    if (!job || !checkpoints) return false;
    if (checkpoints.some((entry) => entry.fact.kind === "proposal.applied"
      && entry.fact.proposalId === proposalId
      && entry.fact.resultRevision === resultRevision)) return true;
    if (job.state === "succeeded" || job.state === "failed" || job.state === "cancelled") return false;
    const appended = await dependencies.jobs.appendCheckpoint(jobId, job.jobVersion, {
      kind: "proposal.applied",
      proposalId,
      resultRevision
    }, now(dependencies));
    if (appended.kind === "updated") return true;
    if (appended.kind !== "job_version_conflict") return false;
  }
  return false;
}

async function ownedJob(
  dependencies: AuthorAssistantDependencies,
  projectId: string,
  questId: string,
  jobId: string,
  actorUserId: string
): Promise<AuthorAgentJobRecord | null> {
  const job = await dependencies.jobs.getJob(jobId);
  if (!job || job.projectId !== projectId || job.questId !== questId || job.ownerUserId !== actorUserId) return null;
  return job;
}

function sameCreateRequest(
  job: AuthorAgentJobRecord,
  dependencies: AuthorAssistantDependencies,
  projectId: string,
  questId: string,
  actorUserId: string,
  body: Record<string, any>
): boolean {
  return job.projectId === projectId && job.questId === questId && job.ownerUserId === actorUserId
    && job.backendId === dependencies.backend.safeView.backendId
    && job.grant.maxToolCalls === (body.maxToolCalls ?? DEFAULT_AUTHOR_AGENT_MAX_TOOL_CALLS)
    && job.grant.maxActiveTimeMs === (body.maxActiveTimeMs ?? DEFAULT_AUTHOR_AGENT_MAX_ACTIVE_TIME_MS);
}

function sendSegmentResult(context: AuthorJobHttpContext, result: RunAuthorAssistantSegmentResult): void {
  if (result.kind === "proposal_ready") {
    context.sendJson(200, { job: result.job, proposal: result.proposal, preview: result.preview, usage: result.usage });
    return;
  }
  if (result.kind === "paused_budget") {
    context.sendJson(409, { error: { code: "AUTHOR_JOB_PAUSED_BUDGET" }, job: result.job });
    return;
  }
  if (result.kind === "proposal_base_conflict") {
    context.sendJson(409, {
      error: { code: "AUTHOR_PROPOSAL_BASE_CONFLICT", currentRevision: result.currentRevision, currentContentHash: result.currentContentHash },
      job: result.job,
      usage: result.usage
    });
    return;
  }
  if (result.kind === "backend_failure") {
    const status = result.code === "rate_limited" ? 429 : 503;
    context.sendJson(status, { error: { code: `AUTHOR_BACKEND_${result.code.toUpperCase()}` }, job: result.job, usage: result.usage });
    return;
  }
  if (result.kind === "invalid_backend_output" || result.kind === "proposal_invalid" || result.kind === "store_unavailable") {
    context.sendJson(422, { error: { code: `AUTHOR_${result.kind.toUpperCase()}` }, job: result.job, usage: result.usage });
    return;
  }
  if (result.kind === "cancelled" || result.kind === "terminal" || result.kind === "job_conflict") {
    context.sendJson(409, { error: { code: `AUTHOR_${result.kind.toUpperCase()}` }, job: result.job });
    return;
  }
  if (result.kind === "job_not_found" || result.kind === "starting_snapshot_unavailable") {
    context.sendNotFound();
    return;
  }
  context.sendJson(400, { error: { code: "INVALID_AUTHOR_SEGMENT_REQUEST" } });
}

function isCreateBody(value: Record<string, any>): boolean {
  const allowed = new Set(["maxToolCalls", "maxActiveTimeMs"]);
  if (!Object.keys(value).every((key) => allowed.has(key))) return false;
  if (value.maxToolCalls !== undefined && (!Number.isSafeInteger(value.maxToolCalls) || value.maxToolCalls < 1)) return false;
  if (value.maxActiveTimeMs !== undefined && (!Number.isSafeInteger(value.maxActiveTimeMs) || value.maxActiveTimeMs < 1)) return false;
  return true;
}

function isSegmentBody(value: Record<string, any>): boolean {
  const keys = value.resumeBudget === undefined ? ["instruction"] : ["instruction", "resumeBudget"];
  return hasExactKeys(value, keys)
    && typeof value.instruction === "string" && value.instruction.length >= 1 && value.instruction.length <= 20_000
    && (value.resumeBudget === undefined || typeof value.resumeBudget === "boolean");
}

function derivedId(prefix: string, value: unknown): string {
  return `${prefix}-${sha256(canonicalStringify(value)).slice(0, 40)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function now(dependencies: AuthorAssistantDependencies): number {
  return dependencies.nowMs ? dependencies.nowMs() : Date.now();
}

function hasExactQuery(search: URLSearchParams, keys: readonly string[]): boolean {
  const actual = [...search.keys()];
  return actual.length === keys.length && keys.every((key) => actual.filter((item) => item === key).length === 1);
}

function hasExactKeys(value: Record<string, any>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
