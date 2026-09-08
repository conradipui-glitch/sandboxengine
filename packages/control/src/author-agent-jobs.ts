// @ts-ignore — Node 24.19.0 provides node:sqlite; repository intentionally has no @types/node dependency yet.
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_CONTROL_SQLITE_BUSY_TIMEOUT_MS, type SQLiteControlStoreOptions } from "./sqlite-store.js";

export const AUTHOR_AGENT_JOB_STATES = Object.freeze([
  "queued",
  "running",
  "waiting_user",
  "paused_budget",
  "validating",
  "succeeded",
  "failed",
  "cancelled"
] as const);

export type AuthorAgentJobState = (typeof AUTHOR_AGENT_JOB_STATES)[number];
export type AuthorAgentOperationKind = "draft.read" | "proposal.preview" | "proposal.apply";
export const DEFAULT_AUTHOR_AGENT_MAX_TOOL_CALLS = 12;
export const DEFAULT_AUTHOR_AGENT_MAX_ACTIVE_TIME_MS = 120_000;
export const MAX_AUTHOR_AGENT_MAX_TOOL_CALLS = 100;
export const MAX_AUTHOR_AGENT_MAX_ACTIVE_TIME_MS = 600_000;

export interface AuthorAgentCapabilityGrant {
  readonly projectId: string;
  readonly questId: string;
  readonly allowedOperations: readonly AuthorAgentOperationKind[];
  readonly maxToolCalls: number;
  readonly maxActiveTimeMs: number;
}

export interface AuthorAgentJobRecord {
  readonly jobId: string;
  readonly projectId: string;
  readonly questId: string;
  readonly ownerUserId: string;
  readonly mode: "author";
  readonly state: AuthorAgentJobState;
  readonly jobVersion: number;
  readonly startingDraftRevision: number;
  readonly startingDraftContentHash: string;
  readonly backendId: string;
  readonly grant: AuthorAgentCapabilityGrant;
  readonly toolCallsUsed: number;
  readonly activeTimeMsUsed: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type AuthorAgentCheckpointFact =
  | { readonly kind: "job.created" }
  | { readonly kind: "job.started" }
  | { readonly kind: "draft.read"; readonly blockCount: number }
  | {
      readonly kind: "context.selected";
      readonly draftRevision: number;
      readonly draftContentHash: string;
      readonly contextHash: string;
      readonly selectedBlockIds: readonly string[];
      readonly includedBlockIds: readonly string[];
    }
  | { readonly kind: "segment.requested"; readonly requestId: string; readonly requestHash: string }
  | { readonly kind: "proposal.produced"; readonly proposalId: string }
  | { readonly kind: "proposal.previewed"; readonly proposalId: string; readonly stale: boolean; readonly applyAllowed: boolean }
  | { readonly kind: "proposal.applied"; readonly proposalId: string; readonly resultRevision: number }
  | { readonly kind: "budget.paused"; readonly toolCallsUsed: number; readonly activeTimeMsUsed: number }
  | { readonly kind: "job.resumed" }
  | { readonly kind: "job.cancelled" }
  | { readonly kind: "job.failed"; readonly code: string }
  | { readonly kind: "job.succeeded" };

export interface AuthorAgentCheckpoint {
  readonly jobId: string;
  readonly ordinal: number;
  readonly fact: AuthorAgentCheckpointFact;
  readonly createdAtMs: number;
}

export type AuthorAgentOperationResult =
  | { readonly kind: "read_blocks"; readonly blockCount: number }
  | { readonly kind: "proposal_previewed"; readonly proposalId: string; readonly stale: boolean; readonly applyAllowed: boolean }
  | { readonly kind: "proposal_applied"; readonly proposalId: string; readonly resultRevision: number; readonly resultContentHash: string };

export interface AuthorAgentOperationRecord {
  readonly jobId: string;
  readonly operationId: string;
  readonly operationKind: AuthorAgentOperationKind;
  readonly baseRevision: number | null;
  readonly requestHash: string;
  readonly status: "pending" | "completed";
  readonly result: AuthorAgentOperationResult | null;
  readonly activeTimeMs: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface CreateAuthorAgentJobInput {
  readonly jobId: string;
  readonly projectId: string;
  readonly questId: string;
  readonly ownerUserId: string;
  readonly startingDraftRevision: number;
  readonly startingDraftContentHash: string;
  readonly backendId: string;
  readonly allowedOperations: readonly AuthorAgentOperationKind[];
  readonly maxToolCalls?: number;
  readonly maxActiveTimeMs?: number;
  readonly createdAtMs: number;
}

export type CreateAuthorAgentJobResult =
  | { readonly kind: "created"; readonly job: AuthorAgentJobRecord }
  | { readonly kind: "job_exists" }
  | { readonly kind: "invalid_request" };

export interface TransitionAuthorAgentJobInput {
  readonly expectedJobVersion: number;
  readonly to: AuthorAgentJobState;
  readonly atMs: number;
  readonly failureCode?: string;
}

export type TransitionAuthorAgentJobResult =
  | { readonly kind: "updated"; readonly job: AuthorAgentJobRecord }
  | { readonly kind: "job_not_found" }
  | { readonly kind: "job_version_conflict"; readonly currentJobVersion: number }
  | { readonly kind: "invalid_transition"; readonly state: AuthorAgentJobState }
  | { readonly kind: "invalid_request" };

export interface ReserveAuthorAgentOperationInput {
  readonly expectedJobVersion: number;
  readonly operationId: string;
  readonly operationKind: AuthorAgentOperationKind;
  readonly baseRevision: number | null;
  readonly requestHash: string;
  readonly atMs: number;
}

export type ReserveAuthorAgentOperationResult =
  | { readonly kind: "reserved"; readonly job: AuthorAgentJobRecord; readonly operation: AuthorAgentOperationRecord }
  | { readonly kind: "replay"; readonly job: AuthorAgentJobRecord; readonly operation: AuthorAgentOperationRecord }
  | { readonly kind: "pending"; readonly job: AuthorAgentJobRecord; readonly operation: AuthorAgentOperationRecord }
  | { readonly kind: "job_not_found" }
  | { readonly kind: "job_version_conflict"; readonly currentJobVersion: number }
  | { readonly kind: "job_not_runnable"; readonly state: AuthorAgentJobState }
  | { readonly kind: "operation_not_allowed" }
  | { readonly kind: "operation_id_reused" }
  | { readonly kind: "budget_exhausted"; readonly job: AuthorAgentJobRecord }
  | { readonly kind: "invalid_request" };

export interface CompleteAuthorAgentOperationInput {
  readonly operationId: string;
  readonly requestHash: string;
  readonly result: AuthorAgentOperationResult;
  readonly activeTimeMs: number;
  readonly atMs: number;
}

export type CompleteAuthorAgentOperationResult =
  | { readonly kind: "completed"; readonly job: AuthorAgentJobRecord; readonly operation: AuthorAgentOperationRecord }
  | { readonly kind: "replay"; readonly job: AuthorAgentJobRecord; readonly operation: AuthorAgentOperationRecord }
  | { readonly kind: "job_not_found" }
  | { readonly kind: "operation_not_found" }
  | { readonly kind: "operation_id_reused" }
  | { readonly kind: "invalid_request" };

export interface AuthorAgentJobStore {
  createJob(input: CreateAuthorAgentJobInput): Promise<CreateAuthorAgentJobResult>;
  getJob(jobId: string): Promise<AuthorAgentJobRecord | null>;
  listJobs(projectId: string, questId: string, ownerUserId: string): Promise<readonly AuthorAgentJobRecord[]>;
  listCheckpoints(jobId: string): Promise<readonly AuthorAgentCheckpoint[] | null>;
  transitionJob(jobId: string, input: TransitionAuthorAgentJobInput): Promise<TransitionAuthorAgentJobResult>;
  appendCheckpoint(jobId: string, expectedJobVersion: number, fact: AuthorAgentCheckpointFact, atMs: number): Promise<TransitionAuthorAgentJobResult>;
  reserveOperation(jobId: string, input: ReserveAuthorAgentOperationInput): Promise<ReserveAuthorAgentOperationResult>;
  completeOperation(jobId: string, input: CompleteAuthorAgentOperationInput): Promise<CompleteAuthorAgentOperationResult>;
}

export class MemoryAuthorAgentJobStore implements AuthorAgentJobStore {
  readonly #jobs = new Map<string, AuthorAgentJobRecord>();
  readonly #checkpoints = new Map<string, AuthorAgentCheckpoint[]>();
  readonly #operations = new Map<string, Map<string, AuthorAgentOperationRecord>>();

  async createJob(input: CreateAuthorAgentJobInput): Promise<CreateAuthorAgentJobResult> {
    const normalized = normalizeCreateInput(input);
    if (!normalized) return frozen({ kind: "invalid_request" });
    if (this.#jobs.has(normalized.jobId)) return frozen({ kind: "job_exists" });
    const job = initialJob(normalized);
    this.#jobs.set(job.jobId, job);
    this.#checkpoints.set(job.jobId, [checkpoint(job.jobId, 0, { kind: "job.created" }, job.createdAtMs)]);
    this.#operations.set(job.jobId, new Map());
    return frozen({ kind: "created", job });
  }

  async getJob(jobId: string): Promise<AuthorAgentJobRecord | null> {
    return this.#jobs.get(jobId) ?? null;
  }

  async listJobs(projectId: string, questId: string, ownerUserId: string): Promise<readonly AuthorAgentJobRecord[]> {
    if (!isId(projectId) || !isId(questId) || !isId(ownerUserId)) return Object.freeze([]);
    const values = [...this.#jobs.values()]
      .filter((job) => job.projectId === projectId && job.questId === questId && job.ownerUserId === ownerUserId)
      .sort(compareJobsNewestFirst)
      .map(cloneJson);
    return deepFreeze(values);
  }

  async listCheckpoints(jobId: string): Promise<readonly AuthorAgentCheckpoint[] | null> {
    const values = this.#checkpoints.get(jobId);
    return values ? deepFreeze(values.map(cloneJson)) : null;
  }

  async transitionJob(jobId: string, input: TransitionAuthorAgentJobInput): Promise<TransitionAuthorAgentJobResult> {
    const current = this.#jobs.get(jobId);
    if (!current) return frozen({ kind: "job_not_found" });
    const validation = validateTransitionInput(input);
    if (!validation) return frozen({ kind: "invalid_request" });
    if (current.jobVersion !== input.expectedJobVersion) {
      return frozen({ kind: "job_version_conflict", currentJobVersion: current.jobVersion });
    }
    if (!transitionAllowed(current.state, input.to)) return frozen({ kind: "invalid_transition", state: current.state });
    const updated = withState(current, input.to, input.atMs);
    this.#jobs.set(jobId, updated);
    const fact = transitionFact(current.state, input.to, input.failureCode, updated);
    if (fact) this.#appendCheckpoint(jobId, fact, input.atMs);
    return frozen({ kind: "updated", job: updated });
  }

  async appendCheckpoint(
    jobId: string,
    expectedJobVersion: number,
    fact: AuthorAgentCheckpointFact,
    atMs: number
  ): Promise<TransitionAuthorAgentJobResult> {
    const current = this.#jobs.get(jobId);
    if (!current) return frozen({ kind: "job_not_found" });
    if (!isNonNegativeSafeInteger(expectedJobVersion) || !isTimestamp(atMs) || !isCheckpointFact(fact)) {
      return frozen({ kind: "invalid_request" });
    }
    if (current.jobVersion !== expectedJobVersion) {
      return frozen({ kind: "job_version_conflict", currentJobVersion: current.jobVersion });
    }
    if (isTerminal(current.state)) return frozen({ kind: "invalid_transition", state: current.state });
    const updated = deepFreeze({ ...current, jobVersion: current.jobVersion + 1, updatedAtMs: atMs });
    this.#jobs.set(jobId, updated);
    this.#appendCheckpoint(jobId, fact, atMs);
    return frozen({ kind: "updated", job: updated });
  }

  async reserveOperation(jobId: string, input: ReserveAuthorAgentOperationInput): Promise<ReserveAuthorAgentOperationResult> {
    const current = this.#jobs.get(jobId);
    if (!current) return frozen({ kind: "job_not_found" });
    if (!validateReserveInput(input)) return frozen({ kind: "invalid_request" });
    const operations = this.#operations.get(jobId)!;
    const existing = operations.get(input.operationId);
    if (existing) return replayOrReuse(current, existing, input);
    if (current.jobVersion !== input.expectedJobVersion) {
      return frozen({ kind: "job_version_conflict", currentJobVersion: current.jobVersion });
    }
    if (current.state !== "running" && current.state !== "validating") {
      return frozen({ kind: "job_not_runnable", state: current.state });
    }
    if (!current.grant.allowedOperations.includes(input.operationKind)) return frozen({ kind: "operation_not_allowed" });
    if (budgetExhausted(current)) return frozen({ kind: "budget_exhausted", job: current });
    const operation = pendingOperation(jobId, input);
    const updated = deepFreeze({
      ...current,
      jobVersion: current.jobVersion + 1,
      toolCallsUsed: current.toolCallsUsed + 1,
      updatedAtMs: input.atMs
    });
    operations.set(operation.operationId, operation);
    this.#jobs.set(jobId, updated);
    return frozen({ kind: "reserved", job: updated, operation });
  }

  async completeOperation(jobId: string, input: CompleteAuthorAgentOperationInput): Promise<CompleteAuthorAgentOperationResult> {
    const current = this.#jobs.get(jobId);
    if (!current) return frozen({ kind: "job_not_found" });
    if (!validateCompleteInput(input)) return frozen({ kind: "invalid_request" });
    const operations = this.#operations.get(jobId)!;
    const existing = operations.get(input.operationId);
    if (!existing) return frozen({ kind: "operation_not_found" });
    if (existing.requestHash !== input.requestHash) return frozen({ kind: "operation_id_reused" });
    if (existing.status === "completed") return frozen({ kind: "replay", job: current, operation: existing });
    const operation = completedOperation(existing, input);
    const nextActive = current.activeTimeMsUsed + input.activeTimeMs;
    const shouldPause = (current.state === "running" || current.state === "validating")
      && (current.toolCallsUsed >= current.grant.maxToolCalls || nextActive >= current.grant.maxActiveTimeMs);
    const updated = deepFreeze({
      ...current,
      state: shouldPause ? "paused_budget" as const : current.state,
      jobVersion: current.jobVersion + 1,
      activeTimeMsUsed: nextActive,
      updatedAtMs: input.atMs
    });
    operations.set(operation.operationId, operation);
    this.#jobs.set(jobId, updated);
    if (shouldPause) this.#appendCheckpoint(jobId, {
      kind: "budget.paused",
      toolCallsUsed: updated.toolCallsUsed,
      activeTimeMsUsed: updated.activeTimeMsUsed
    }, input.atMs);
    return frozen({ kind: "completed", job: updated, operation });
  }

  #appendCheckpoint(jobId: string, fact: AuthorAgentCheckpointFact, atMs: number): void {
    const values = this.#checkpoints.get(jobId);
    if (!values) throw new Error("missing checkpoint journal");
    values.push(checkpoint(jobId, values.length, fact, atMs));
  }
}

export class SQLiteAuthorAgentJobStore implements AuthorAgentJobStore {
  readonly #db: any;
  #closed = false;

  constructor(options: SQLiteControlStoreOptions) {
    const timeout = options.busyTimeoutMs ?? DEFAULT_CONTROL_SQLITE_BUSY_TIMEOUT_MS;
    this.#db = new DatabaseSync(options.path, {
      timeout,
      defensive: true,
      enableForeignKeyConstraints: true,
      allowExtension: false
    });
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS control_author_agent_jobs (
        job_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        quest_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        state TEXT NOT NULL,
        job_version INTEGER NOT NULL CHECK (job_version >= 0),
        starting_draft_revision INTEGER NOT NULL CHECK (starting_draft_revision >= 0),
        starting_draft_content_hash TEXT NOT NULL,
        backend_id TEXT NOT NULL,
        allowed_operations_json TEXT NOT NULL,
        max_tool_calls INTEGER NOT NULL CHECK (max_tool_calls > 0),
        max_active_time_ms INTEGER NOT NULL CHECK (max_active_time_ms > 0),
        tool_calls_used INTEGER NOT NULL CHECK (tool_calls_used >= 0),
        active_time_ms_used INTEGER NOT NULL CHECK (active_time_ms_used >= 0),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_author_agent_checkpoints (
        job_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        fact_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        PRIMARY KEY (job_id, ordinal),
        FOREIGN KEY (job_id) REFERENCES control_author_agent_jobs(job_id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_author_agent_operations (
        job_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        operation_kind TEXT NOT NULL,
        base_revision INTEGER,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
        result_json TEXT,
        active_time_ms INTEGER NOT NULL CHECK (active_time_ms >= 0),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
        PRIMARY KEY (job_id, operation_id),
        FOREIGN KEY (job_id) REFERENCES control_author_agent_jobs(job_id) ON DELETE CASCADE
      ) STRICT;
    `);
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }

  async createJob(input: CreateAuthorAgentJobInput): Promise<CreateAuthorAgentJobResult> {
    this.#assertOpen();
    const normalized = normalizeCreateInput(input);
    if (!normalized) return frozen({ kind: "invalid_request" });
    const job = initialJob(normalized);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#db.prepare("SELECT job_id FROM control_author_agent_jobs WHERE job_id = ?").get(job.jobId);
      if (existing) { this.#db.exec("ROLLBACK"); return frozen({ kind: "job_exists" }); }
      this.#insertJob(job);
      this.#insertCheckpoint(checkpoint(job.jobId, 0, { kind: "job.created" }, job.createdAtMs));
      this.#db.exec("COMMIT");
      return frozen({ kind: "created", job });
    } catch (error) {
      safeRollback(this.#db);
      throw error;
    }
  }

  async getJob(jobId: string): Promise<AuthorAgentJobRecord | null> {
    this.#assertOpen();
    if (!isId(jobId)) return null;
    const row = this.#db.prepare("SELECT * FROM control_author_agent_jobs WHERE job_id = ?").get(jobId);
    return row ? jobFromRow(row) : null;
  }

  async listJobs(projectId: string, questId: string, ownerUserId: string): Promise<readonly AuthorAgentJobRecord[]> {
    this.#assertOpen();
    if (!isId(projectId) || !isId(questId) || !isId(ownerUserId)) return Object.freeze([]);
    const rows = this.#db.prepare(`
      SELECT * FROM control_author_agent_jobs
      WHERE project_id = ? AND quest_id = ? AND owner_user_id = ?
      ORDER BY updated_at_ms DESC, created_at_ms DESC, job_id ASC
    `).all(projectId, questId, ownerUserId);
    return deepFreeze(rows.map((row: any) => jobFromRow(row)));
  }

  async listCheckpoints(jobId: string): Promise<readonly AuthorAgentCheckpoint[] | null> {
    this.#assertOpen();
    const job = await this.getJob(jobId);
    if (!job) return null;
    const rows = this.#db.prepare(`
      SELECT ordinal, fact_json, created_at_ms
      FROM control_author_agent_checkpoints
      WHERE job_id = ? ORDER BY ordinal ASC
    `).all(jobId);
    return deepFreeze(rows.map((row: any) => checkpointFromRow(jobId, row)));
  }

  async transitionJob(jobId: string, input: TransitionAuthorAgentJobInput): Promise<TransitionAuthorAgentJobResult> {
    this.#assertOpen();
    if (!validateTransitionInput(input)) return frozen({ kind: "invalid_request" });
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#readJob(jobId);
      if (!current) { this.#db.exec("ROLLBACK"); return frozen({ kind: "job_not_found" }); }
      if (current.jobVersion !== input.expectedJobVersion) {
        this.#db.exec("ROLLBACK");
        return frozen({ kind: "job_version_conflict", currentJobVersion: current.jobVersion });
      }
      if (!transitionAllowed(current.state, input.to)) {
        this.#db.exec("ROLLBACK");
        return frozen({ kind: "invalid_transition", state: current.state });
      }
      const updated = withState(current, input.to, input.atMs);
      this.#updateJob(updated);
      const fact = transitionFact(current.state, input.to, input.failureCode, updated);
      if (fact) this.#insertCheckpoint(this.#nextCheckpoint(updated.jobId, fact, input.atMs));
      this.#db.exec("COMMIT");
      return frozen({ kind: "updated", job: updated });
    } catch (error) {
      safeRollback(this.#db);
      throw error;
    }
  }

  async appendCheckpoint(
    jobId: string,
    expectedJobVersion: number,
    fact: AuthorAgentCheckpointFact,
    atMs: number
  ): Promise<TransitionAuthorAgentJobResult> {
    this.#assertOpen();
    if (!isNonNegativeSafeInteger(expectedJobVersion) || !isTimestamp(atMs) || !isCheckpointFact(fact)) {
      return frozen({ kind: "invalid_request" });
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#readJob(jobId);
      if (!current) { this.#db.exec("ROLLBACK"); return frozen({ kind: "job_not_found" }); }
      if (current.jobVersion !== expectedJobVersion) {
        this.#db.exec("ROLLBACK");
        return frozen({ kind: "job_version_conflict", currentJobVersion: current.jobVersion });
      }
      if (isTerminal(current.state)) {
        this.#db.exec("ROLLBACK");
        return frozen({ kind: "invalid_transition", state: current.state });
      }
      const updated = deepFreeze({ ...current, jobVersion: current.jobVersion + 1, updatedAtMs: atMs });
      this.#updateJob(updated);
      this.#insertCheckpoint(this.#nextCheckpoint(jobId, fact, atMs));
      this.#db.exec("COMMIT");
      return frozen({ kind: "updated", job: updated });
    } catch (error) {
      safeRollback(this.#db);
      throw error;
    }
  }

  async reserveOperation(jobId: string, input: ReserveAuthorAgentOperationInput): Promise<ReserveAuthorAgentOperationResult> {
    this.#assertOpen();
    if (!validateReserveInput(input)) return frozen({ kind: "invalid_request" });
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#readJob(jobId);
      if (!current) { this.#db.exec("ROLLBACK"); return frozen({ kind: "job_not_found" }); }
      const existing = this.#readOperation(jobId, input.operationId);
      if (existing) {
        this.#db.exec("ROLLBACK");
        return replayOrReuse(current, existing, input);
      }
      if (current.jobVersion !== input.expectedJobVersion) {
        this.#db.exec("ROLLBACK");
        return frozen({ kind: "job_version_conflict", currentJobVersion: current.jobVersion });
      }
      if (current.state !== "running" && current.state !== "validating") {
        this.#db.exec("ROLLBACK");
        return frozen({ kind: "job_not_runnable", state: current.state });
      }
      if (!current.grant.allowedOperations.includes(input.operationKind)) {
        this.#db.exec("ROLLBACK");
        return frozen({ kind: "operation_not_allowed" });
      }
      if (budgetExhausted(current)) {
        this.#db.exec("ROLLBACK");
        return frozen({ kind: "budget_exhausted", job: current });
      }
      const operation = pendingOperation(jobId, input);
      const updated = deepFreeze({
        ...current,
        jobVersion: current.jobVersion + 1,
        toolCallsUsed: current.toolCallsUsed + 1,
        updatedAtMs: input.atMs
      });
      this.#insertOperation(operation);
      this.#updateJob(updated);
      this.#db.exec("COMMIT");
      return frozen({ kind: "reserved", job: updated, operation });
    } catch (error) {
      safeRollback(this.#db);
      throw error;
    }
  }

  async completeOperation(jobId: string, input: CompleteAuthorAgentOperationInput): Promise<CompleteAuthorAgentOperationResult> {
    this.#assertOpen();
    if (!validateCompleteInput(input)) return frozen({ kind: "invalid_request" });
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#readJob(jobId);
      if (!current) { this.#db.exec("ROLLBACK"); return frozen({ kind: "job_not_found" }); }
      const existing = this.#readOperation(jobId, input.operationId);
      if (!existing) { this.#db.exec("ROLLBACK"); return frozen({ kind: "operation_not_found" }); }
      if (existing.requestHash !== input.requestHash) {
        this.#db.exec("ROLLBACK");
        return frozen({ kind: "operation_id_reused" });
      }
      if (existing.status === "completed") {
        this.#db.exec("ROLLBACK");
        return frozen({ kind: "replay", job: current, operation: existing });
      }
      const operation = completedOperation(existing, input);
      const nextActive = current.activeTimeMsUsed + input.activeTimeMs;
      const shouldPause = (current.state === "running" || current.state === "validating")
        && (current.toolCallsUsed >= current.grant.maxToolCalls || nextActive >= current.grant.maxActiveTimeMs);
      const updated = deepFreeze({
        ...current,
        state: shouldPause ? "paused_budget" as const : current.state,
        jobVersion: current.jobVersion + 1,
        activeTimeMsUsed: nextActive,
        updatedAtMs: input.atMs
      });
      this.#updateOperation(operation);
      this.#updateJob(updated);
      if (shouldPause) this.#insertCheckpoint(this.#nextCheckpoint(jobId, {
        kind: "budget.paused",
        toolCallsUsed: updated.toolCallsUsed,
        activeTimeMsUsed: updated.activeTimeMsUsed
      }, input.atMs));
      this.#db.exec("COMMIT");
      return frozen({ kind: "completed", job: updated, operation });
    } catch (error) {
      safeRollback(this.#db);
      throw error;
    }
  }

  #readJob(jobId: string): AuthorAgentJobRecord | null {
    if (!isId(jobId)) return null;
    const row = this.#db.prepare("SELECT * FROM control_author_agent_jobs WHERE job_id = ?").get(jobId);
    return row ? jobFromRow(row) : null;
  }

  #insertJob(job: AuthorAgentJobRecord): void {
    this.#db.prepare(`
      INSERT INTO control_author_agent_jobs
        (job_id, project_id, quest_id, owner_user_id, state, job_version,
         starting_draft_revision, starting_draft_content_hash, backend_id, allowed_operations_json,
         max_tool_calls, max_active_time_ms, tool_calls_used, active_time_ms_used, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.jobId, job.projectId, job.questId, job.ownerUserId, job.state, job.jobVersion,
      job.startingDraftRevision, job.startingDraftContentHash, job.backendId, JSON.stringify(job.grant.allowedOperations),
      job.grant.maxToolCalls, job.grant.maxActiveTimeMs, job.toolCallsUsed, job.activeTimeMsUsed,
      job.createdAtMs, job.updatedAtMs
    );
  }

  #updateJob(job: AuthorAgentJobRecord): void {
    const result = this.#db.prepare(`
      UPDATE control_author_agent_jobs
      SET state = ?, job_version = ?, tool_calls_used = ?, active_time_ms_used = ?, updated_at_ms = ?
      WHERE job_id = ?
    `).run(job.state, job.jobVersion, job.toolCallsUsed, job.activeTimeMsUsed, job.updatedAtMs, job.jobId);
    if (Number(result.changes) !== 1) throw new Error("author agent job update lost");
  }

  #nextCheckpoint(jobId: string, fact: AuthorAgentCheckpointFact, atMs: number): AuthorAgentCheckpoint {
    const row = this.#db.prepare(`
      SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
      FROM control_author_agent_checkpoints WHERE job_id = ?
    `).get(jobId);
    return checkpoint(jobId, Number(row.max_ordinal) + 1, fact, atMs);
  }

  #insertCheckpoint(value: AuthorAgentCheckpoint): void {
    this.#db.prepare(`
      INSERT INTO control_author_agent_checkpoints (job_id, ordinal, fact_json, created_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(value.jobId, value.ordinal, JSON.stringify(value.fact), value.createdAtMs);
  }

  #readOperation(jobId: string, operationId: string): AuthorAgentOperationRecord | null {
    if (!isId(jobId) || !isId(operationId)) return null;
    const row = this.#db.prepare(`
      SELECT * FROM control_author_agent_operations WHERE job_id = ? AND operation_id = ?
    `).get(jobId, operationId);
    return row ? operationFromRow(row) : null;
  }

  #insertOperation(value: AuthorAgentOperationRecord): void {
    this.#db.prepare(`
      INSERT INTO control_author_agent_operations
        (job_id, operation_id, operation_kind, base_revision, request_hash, status,
         result_json, active_time_ms, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `).run(
      value.jobId, value.operationId, value.operationKind, value.baseRevision, value.requestHash, value.status,
      value.activeTimeMs, value.createdAtMs, value.updatedAtMs
    );
  }

  #updateOperation(value: AuthorAgentOperationRecord): void {
    const result = this.#db.prepare(`
      UPDATE control_author_agent_operations
      SET status = ?, result_json = ?, active_time_ms = ?, updated_at_ms = ?
      WHERE job_id = ? AND operation_id = ?
    `).run(
      value.status, value.result === null ? null : JSON.stringify(value.result), value.activeTimeMs, value.updatedAtMs,
      value.jobId, value.operationId
    );
    if (Number(result.changes) !== 1) throw new Error("author agent operation update lost");
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("SQLiteAuthorAgentJobStore is closed");
  }
}

function initialJob(input: Required<CreateAuthorAgentJobInput>): AuthorAgentJobRecord {
  return deepFreeze({
    jobId: input.jobId,
    projectId: input.projectId,
    questId: input.questId,
    ownerUserId: input.ownerUserId,
    mode: "author" as const,
    state: "queued" as const,
    jobVersion: 0,
    startingDraftRevision: input.startingDraftRevision,
    startingDraftContentHash: input.startingDraftContentHash,
    backendId: input.backendId,
    grant: {
      projectId: input.projectId,
      questId: input.questId,
      allowedOperations: Object.freeze([...input.allowedOperations]),
      maxToolCalls: input.maxToolCalls,
      maxActiveTimeMs: input.maxActiveTimeMs
    },
    toolCallsUsed: 0,
    activeTimeMsUsed: 0,
    createdAtMs: input.createdAtMs,
    updatedAtMs: input.createdAtMs
  });
}

function normalizeCreateInput(input: CreateAuthorAgentJobInput): Required<CreateAuthorAgentJobInput> | null {
  const maxToolCalls = input.maxToolCalls ?? DEFAULT_AUTHOR_AGENT_MAX_TOOL_CALLS;
  const maxActiveTimeMs = input.maxActiveTimeMs ?? DEFAULT_AUTHOR_AGENT_MAX_ACTIVE_TIME_MS;
  if (!isId(input.jobId) || !isId(input.projectId) || !isId(input.questId) || !isId(input.ownerUserId)
    || !isNonNegativeSafeInteger(input.startingDraftRevision) || !isHash(input.startingDraftContentHash)
    || !isId(input.backendId) || !isTimestamp(input.createdAtMs)
    || !Array.isArray(input.allowedOperations) || input.allowedOperations.length < 1
    || !input.allowedOperations.every(isOperationKind)
    || new Set(input.allowedOperations).size !== input.allowedOperations.length
    || !Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > MAX_AUTHOR_AGENT_MAX_TOOL_CALLS
    || !Number.isSafeInteger(maxActiveTimeMs) || maxActiveTimeMs < 1 || maxActiveTimeMs > MAX_AUTHOR_AGENT_MAX_ACTIVE_TIME_MS) return null;
  return Object.freeze({ ...input, maxToolCalls, maxActiveTimeMs });
}

function validateTransitionInput(input: TransitionAuthorAgentJobInput): boolean {
  return isNonNegativeSafeInteger(input.expectedJobVersion)
    && isState(input.to)
    && isTimestamp(input.atMs)
    && (input.failureCode === undefined || isId(input.failureCode))
    && (input.to === "failed" ? isId(input.failureCode) : input.failureCode === undefined);
}

function transitionAllowed(from: AuthorAgentJobState, to: AuthorAgentJobState): boolean {
  if (isTerminal(from)) return false;
  if (to === "cancelled") return true;
  if (from === "queued") return to === "running";
  if (from === "running") return to === "waiting_user" || to === "paused_budget" || to === "validating" || to === "succeeded" || to === "failed";
  if (from === "waiting_user" || from === "paused_budget") return to === "running";
  if (from === "validating") return to === "running" || to === "succeeded" || to === "failed" || to === "paused_budget";
  return false;
}

function withState(job: AuthorAgentJobRecord, state: AuthorAgentJobState, atMs: number): AuthorAgentJobRecord {
  const resetSegmentBudget = job.state === "paused_budget" && state === "running";
  return deepFreeze({
    ...job,
    state,
    jobVersion: job.jobVersion + 1,
    toolCallsUsed: resetSegmentBudget ? 0 : job.toolCallsUsed,
    activeTimeMsUsed: resetSegmentBudget ? 0 : job.activeTimeMsUsed,
    updatedAtMs: atMs
  });
}

function transitionFact(
  from: AuthorAgentJobState,
  state: AuthorAgentJobState,
  failureCode: string | undefined,
  job: AuthorAgentJobRecord
): AuthorAgentCheckpointFact | null {
  if (state === "running") {
    if (from === "queued") return { kind: "job.started" };
    if (from === "paused_budget" || from === "waiting_user") return { kind: "job.resumed" };
    return null;
  }
  if (state === "paused_budget") return { kind: "budget.paused", toolCallsUsed: job.toolCallsUsed, activeTimeMsUsed: job.activeTimeMsUsed };
  if (state === "cancelled") return { kind: "job.cancelled" };
  if (state === "failed") return { kind: "job.failed", code: failureCode! };
  if (state === "succeeded") return { kind: "job.succeeded" };
  return null;
}

function validateReserveInput(input: ReserveAuthorAgentOperationInput): boolean {
  return isNonNegativeSafeInteger(input.expectedJobVersion)
    && isId(input.operationId)
    && isOperationKind(input.operationKind)
    && (input.baseRevision === null || isNonNegativeSafeInteger(input.baseRevision))
    && isHash(input.requestHash)
    && isTimestamp(input.atMs);
}

function validateCompleteInput(input: CompleteAuthorAgentOperationInput): boolean {
  return isId(input.operationId)
    && isHash(input.requestHash)
    && isOperationResult(input.result)
    && isNonNegativeSafeInteger(input.activeTimeMs)
    && input.activeTimeMs <= MAX_AUTHOR_AGENT_MAX_ACTIVE_TIME_MS
    && isTimestamp(input.atMs);
}

function pendingOperation(jobId: string, input: ReserveAuthorAgentOperationInput): AuthorAgentOperationRecord {
  return deepFreeze({
    jobId,
    operationId: input.operationId,
    operationKind: input.operationKind,
    baseRevision: input.baseRevision,
    requestHash: input.requestHash,
    status: "pending" as const,
    result: null,
    activeTimeMs: 0,
    createdAtMs: input.atMs,
    updatedAtMs: input.atMs
  });
}

function completedOperation(
  current: AuthorAgentOperationRecord,
  input: CompleteAuthorAgentOperationInput
): AuthorAgentOperationRecord {
  return deepFreeze({
    ...current,
    status: "completed" as const,
    result: cloneJson(input.result),
    activeTimeMs: input.activeTimeMs,
    updatedAtMs: input.atMs
  });
}

function replayOrReuse(
  job: AuthorAgentJobRecord,
  existing: AuthorAgentOperationRecord,
  input: ReserveAuthorAgentOperationInput
): ReserveAuthorAgentOperationResult {
  if (existing.requestHash !== input.requestHash
    || existing.operationKind !== input.operationKind
    || existing.baseRevision !== input.baseRevision) return frozen({ kind: "operation_id_reused" });
  return existing.status === "completed"
    ? frozen({ kind: "replay", job, operation: existing })
    : frozen({ kind: "pending", job, operation: existing });
}

function compareJobsNewestFirst(left: AuthorAgentJobRecord, right: AuthorAgentJobRecord): number {
  if (left.updatedAtMs !== right.updatedAtMs) return right.updatedAtMs - left.updatedAtMs;
  if (left.createdAtMs !== right.createdAtMs) return right.createdAtMs - left.createdAtMs;
  return left.jobId.localeCompare(right.jobId);
}

function budgetExhausted(job: AuthorAgentJobRecord): boolean {
  return job.toolCallsUsed >= job.grant.maxToolCalls || job.activeTimeMsUsed >= job.grant.maxActiveTimeMs;
}

function checkpoint(
  jobId: string,
  ordinal: number,
  fact: AuthorAgentCheckpointFact,
  createdAtMs: number
): AuthorAgentCheckpoint {
  return deepFreeze({ jobId, ordinal, fact: cloneJson(fact), createdAtMs });
}

function jobFromRow(row: any): AuthorAgentJobRecord {
  const allowed = JSON.parse(String(row.allowed_operations_json));
  if (!Array.isArray(allowed) || allowed.length < 1 || !allowed.every(isOperationKind)) throw new Error("corrupt author agent operation grant");
  const state = String(row.state);
  if (!isState(state)) throw new Error("corrupt author agent job state");
  return deepFreeze({
    jobId: String(row.job_id),
    projectId: String(row.project_id),
    questId: String(row.quest_id),
    ownerUserId: String(row.owner_user_id),
    mode: "author" as const,
    state,
    jobVersion: Number(row.job_version),
    startingDraftRevision: Number(row.starting_draft_revision),
    startingDraftContentHash: String(row.starting_draft_content_hash),
    backendId: String(row.backend_id),
    grant: {
      projectId: String(row.project_id),
      questId: String(row.quest_id),
      allowedOperations: Object.freeze([...allowed]),
      maxToolCalls: Number(row.max_tool_calls),
      maxActiveTimeMs: Number(row.max_active_time_ms)
    },
    toolCallsUsed: Number(row.tool_calls_used),
    activeTimeMsUsed: Number(row.active_time_ms_used),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms)
  });
}

function checkpointFromRow(jobId: string, row: any): AuthorAgentCheckpoint {
  const fact = JSON.parse(String(row.fact_json));
  if (!isCheckpointFact(fact)) throw new Error("corrupt author agent checkpoint");
  return checkpoint(jobId, Number(row.ordinal), fact, Number(row.created_at_ms));
}

function operationFromRow(row: any): AuthorAgentOperationRecord {
  const status = String(row.status);
  if (status !== "pending" && status !== "completed") throw new Error("corrupt author agent operation status");
  const operationKind = String(row.operation_kind);
  if (!isOperationKind(operationKind)) throw new Error("corrupt author agent operation kind");
  let result: AuthorAgentOperationResult | null = null;
  if (row.result_json !== null) {
    const parsed = JSON.parse(String(row.result_json));
    if (!isOperationResult(parsed)) throw new Error("corrupt author agent operation result");
    result = parsed;
  }
  if (status === "completed" && result === null) throw new Error("completed author agent operation missing result");
  return deepFreeze({
    jobId: String(row.job_id),
    operationId: String(row.operation_id),
    operationKind,
    baseRevision: row.base_revision === null ? null : Number(row.base_revision),
    requestHash: String(row.request_hash),
    status,
    result: result ? cloneJson(result) : null,
    activeTimeMs: Number(row.active_time_ms),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms)
  });
}

function isCheckpointFact(value: unknown): value is AuthorAgentCheckpointFact {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "job.created":
    case "job.started":
    case "job.resumed":
    case "job.cancelled":
    case "job.succeeded":
      return hasExactKeys(value, ["kind"]);
    case "draft.read":
      return hasExactKeys(value, ["kind", "blockCount"]) && isNonNegativeSafeInteger(value.blockCount);
    case "context.selected":
      return hasExactKeys(value, [
        "kind", "draftRevision", "draftContentHash", "contextHash", "selectedBlockIds", "includedBlockIds"
      ])
        && isNonNegativeSafeInteger(value.draftRevision)
        && isHash(value.draftContentHash)
        && isHash(value.contextHash)
        && isBoundedIdList(value.selectedBlockIds, 32, 1)
        && isBoundedIdList(value.includedBlockIds, 64, 1)
        && value.selectedBlockIds.every((id: string) => value.includedBlockIds.includes(id));
    case "segment.requested":
      return hasExactKeys(value, ["kind", "requestId", "requestHash"])
        && isId(value.requestId) && isHash(value.requestHash);
    case "proposal.produced":
      return hasExactKeys(value, ["kind", "proposalId"]) && isId(value.proposalId);
    case "proposal.previewed":
      return hasExactKeys(value, ["kind", "proposalId", "stale", "applyAllowed"])
        && isId(value.proposalId) && typeof value.stale === "boolean" && typeof value.applyAllowed === "boolean";
    case "proposal.applied":
      return hasExactKeys(value, ["kind", "proposalId", "resultRevision"])
        && isId(value.proposalId) && isNonNegativeSafeInteger(value.resultRevision);
    case "budget.paused":
      return hasExactKeys(value, ["kind", "toolCallsUsed", "activeTimeMsUsed"])
        && isNonNegativeSafeInteger(value.toolCallsUsed) && isNonNegativeSafeInteger(value.activeTimeMsUsed);
    case "job.failed":
      return hasExactKeys(value, ["kind", "code"]) && isId(value.code);
    default:
      return false;
  }
}

function isOperationResult(value: unknown): value is AuthorAgentOperationResult {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "read_blocks") {
    return hasExactKeys(value, ["kind", "blockCount"]) && isNonNegativeSafeInteger(value.blockCount);
  }
  if (value.kind === "proposal_previewed") {
    return hasExactKeys(value, ["kind", "proposalId", "stale", "applyAllowed"])
      && isId(value.proposalId) && typeof value.stale === "boolean" && typeof value.applyAllowed === "boolean";
  }
  if (value.kind === "proposal_applied") {
    return hasExactKeys(value, ["kind", "proposalId", "resultRevision", "resultContentHash"])
      && isId(value.proposalId) && isNonNegativeSafeInteger(value.resultRevision) && isHash(value.resultContentHash);
  }
  return false;
}

function isState(value: unknown): value is AuthorAgentJobState {
  return typeof value === "string" && (AUTHOR_AGENT_JOB_STATES as readonly string[]).includes(value);
}

function isTerminal(state: AuthorAgentJobState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

function isOperationKind(value: unknown): value is AuthorAgentOperationKind {
  return value === "draft.read" || value === "proposal.preview" || value === "proposal.apply";
}

function isBoundedIdList(value: unknown, max: number, min = 0): value is string[] {
  return Array.isArray(value)
    && value.length >= min
    && value.length <= max
    && value.every(isId)
    && new Set(value).size === value.length;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isTimestamp(value: unknown): value is number {
  return isNonNegativeSafeInteger(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, any>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeRollback(db: any): void {
  try { db.exec("ROLLBACK"); } catch {}
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
