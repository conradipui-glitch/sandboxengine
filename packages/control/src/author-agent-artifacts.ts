// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
import { createHash } from "node:crypto";
// @ts-ignore — Node 24.19.0 provides node:sqlite; repository intentionally has no @types/node dependency yet.
import { DatabaseSync } from "node:sqlite";
import { canonicalStringify } from "@living-history/core";
import type { AuthoringProposal } from "./authoring-proposal.js";
import type { AuthorAgentJobStore } from "./author-agent-jobs.js";
import { DEFAULT_CONTROL_SQLITE_BUSY_TIMEOUT_MS, type SQLiteControlStoreOptions } from "./sqlite-store.js";

export interface AuthorAgentProposalUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export interface AuthorAgentProposalArtifact {
  readonly jobId: string;
  readonly turnKey: string;
  readonly artifactHash: string;
  readonly proposal: AuthoringProposal;
  readonly usage: AuthorAgentProposalUsage;
  readonly createdAtMs: number;
}

export interface SaveAuthorAgentProposalArtifactInput {
  readonly turnKey: string;
  readonly proposal: AuthoringProposal;
  readonly usage: AuthorAgentProposalUsage;
  readonly createdAtMs: number;
}

export type SaveAuthorAgentProposalArtifactResult =
  | { readonly kind: "stored"; readonly artifact: AuthorAgentProposalArtifact }
  | { readonly kind: "replay"; readonly artifact: AuthorAgentProposalArtifact }
  | { readonly kind: "job_not_found" }
  | { readonly kind: "turn_key_reused" }
  | { readonly kind: "invalid_request" };

export interface AuthorAgentProposalArtifactStore {
  getProposalArtifact(jobId: string, turnKey: string): Promise<AuthorAgentProposalArtifact | null>;
  saveProposalArtifact(jobId: string, input: SaveAuthorAgentProposalArtifactInput): Promise<SaveAuthorAgentProposalArtifactResult>;
}

export class MemoryAuthorAgentProposalArtifactStore implements AuthorAgentProposalArtifactStore {
  readonly #artifacts = new Map<string, AuthorAgentProposalArtifact>();

  constructor(readonly jobs: Pick<AuthorAgentJobStore, "getJob">) {}

  async getProposalArtifact(jobId: string, turnKey: string): Promise<AuthorAgentProposalArtifact | null> {
    if (!isId(jobId) || !isHash(turnKey)) return null;
    return this.#artifacts.get(key(jobId, turnKey)) ?? null;
  }

  async saveProposalArtifact(jobId: string, input: SaveAuthorAgentProposalArtifactInput): Promise<SaveAuthorAgentProposalArtifactResult> {
    const artifact = buildArtifact(jobId, input);
    if (!artifact) return frozen({ kind: "invalid_request" });
    if (!(await this.jobs.getJob(jobId))) return frozen({ kind: "job_not_found" });
    const artifactKey = key(jobId, input.turnKey);
    const existing = this.#artifacts.get(artifactKey);
    if (existing) {
      return existing.artifactHash === artifact.artifactHash
        ? frozen({ kind: "replay", artifact: existing })
        : frozen({ kind: "turn_key_reused" });
    }
    this.#artifacts.set(artifactKey, artifact);
    return frozen({ kind: "stored", artifact });
  }
}

export class SQLiteAuthorAgentProposalArtifactStore implements AuthorAgentProposalArtifactStore {
  readonly #db: any;
  #closed = false;

  constructor(readonly jobs: Pick<AuthorAgentJobStore, "getJob">, options: SQLiteControlStoreOptions) {
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
      CREATE TABLE IF NOT EXISTS control_author_agent_proposal_artifacts (
        job_id TEXT NOT NULL,
        turn_key TEXT NOT NULL,
        artifact_hash TEXT NOT NULL,
        proposal_json TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        PRIMARY KEY (job_id, turn_key),
        FOREIGN KEY (job_id) REFERENCES control_author_agent_jobs(job_id) ON DELETE CASCADE
      ) STRICT;
    `);
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }

  async getProposalArtifact(jobId: string, turnKey: string): Promise<AuthorAgentProposalArtifact | null> {
    this.#assertOpen();
    if (!isId(jobId) || !isHash(turnKey)) return null;
    const row = this.#db.prepare(`
      SELECT artifact_hash, proposal_json, usage_json, created_at_ms
      FROM control_author_agent_proposal_artifacts
      WHERE job_id = ? AND turn_key = ?
    `).get(jobId, turnKey);
    return row ? artifactFromRow(jobId, turnKey, row) : null;
  }

  async saveProposalArtifact(jobId: string, input: SaveAuthorAgentProposalArtifactInput): Promise<SaveAuthorAgentProposalArtifactResult> {
    this.#assertOpen();
    const artifact = buildArtifact(jobId, input);
    if (!artifact) return frozen({ kind: "invalid_request" });
    if (!(await this.jobs.getJob(jobId))) return frozen({ kind: "job_not_found" });
    const inserted = this.#db.prepare(`
      INSERT OR IGNORE INTO control_author_agent_proposal_artifacts
        (job_id, turn_key, artifact_hash, proposal_json, usage_json, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      artifact.jobId,
      artifact.turnKey,
      artifact.artifactHash,
      canonicalStringify(artifact.proposal),
      canonicalStringify(artifact.usage),
      artifact.createdAtMs
    );
    const stored = await this.getProposalArtifact(jobId, input.turnKey);
    if (!stored) throw new Error("failed to persist author proposal artifact");
    return stored.artifactHash === artifact.artifactHash
      ? frozen({ kind: Number(inserted.changes) === 1 ? "stored" as const : "replay" as const, artifact: stored })
      : frozen({ kind: "turn_key_reused" });
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("SQLiteAuthorAgentProposalArtifactStore is closed");
  }
}

function buildArtifact(jobId: string, input: SaveAuthorAgentProposalArtifactInput): AuthorAgentProposalArtifact | null {
  if (!isId(jobId) || !isHash(input?.turnKey) || !isTimestamp(input?.createdAtMs)
    || !isAuthoringProposal(input?.proposal) || !isUsage(input?.usage)
    || input.proposal.origin.jobId !== jobId) return null;
  const proposal = deepFreeze(cloneJson(input.proposal));
  const usage = deepFreeze(cloneJson(input.usage));
  const artifactHash = sha256(canonicalStringify({ jobId, turnKey: input.turnKey, proposal, usage }));
  return deepFreeze({ jobId, turnKey: input.turnKey, artifactHash, proposal, usage, createdAtMs: input.createdAtMs });
}

function artifactFromRow(jobId: string, turnKey: string, row: any): AuthorAgentProposalArtifact {
  const proposal = JSON.parse(String(row.proposal_json));
  const usage = JSON.parse(String(row.usage_json));
  if (!isAuthoringProposal(proposal) || !isUsage(usage) || proposal.origin.jobId !== jobId) {
    throw new Error("corrupt author proposal artifact");
  }
  const artifact = deepFreeze({
    jobId,
    turnKey,
    artifactHash: String(row.artifact_hash),
    proposal: deepFreeze(proposal),
    usage: deepFreeze(usage),
    createdAtMs: Number(row.created_at_ms)
  });
  const expected = sha256(canonicalStringify({ jobId, turnKey, proposal: artifact.proposal, usage: artifact.usage }));
  if (!isHash(artifact.artifactHash) || artifact.artifactHash !== expected || !isTimestamp(artifact.createdAtMs)) {
    throw new Error("corrupt author proposal artifact integrity");
  }
  return artifact;
}

function isAuthoringProposal(value: unknown): value is AuthoringProposal {
  if (!isRecord(value) || !hasExactKeys(value, [
    "proposalId", "projectId", "questId", "baseRevision", "baseContentHash",
    "explanation", "changes", "missingCapabilities", "origin"
  ])) return false;
  if (!isId(value.proposalId) || !isId(value.projectId) || !isId(value.questId)
    || !isNonNegativeSafeInteger(value.baseRevision) || !isHash(value.baseContentHash)
    || typeof value.explanation !== "string" || value.explanation.length < 1 || value.explanation.length > 4_000
    || !Array.isArray(value.changes) || value.changes.length > 100
    || !Array.isArray(value.missingCapabilities) || value.missingCapabilities.length > 20
    || !isRecord(value.origin) || !hasExactKeys(value.origin, ["kind", "backendId", "jobId"])
    || value.origin.kind !== "assistant" || !isId(value.origin.backendId)
    || !(value.origin.jobId === null || isId(value.origin.jobId))) return false;
  return true;
}

function isUsage(value: unknown): value is AuthorAgentProposalUsage {
  return isRecord(value) && hasExactKeys(value, ["inputTokens", "outputTokens", "totalTokens"])
    && isToken(value.inputTokens) && isToken(value.outputTokens) && isToken(value.totalTokens);
}

function isToken(value: unknown): value is number | null {
  return value === null || isNonNegativeSafeInteger(value);
}

function key(jobId: string, turnKey: string): string {
  return `${jobId}\u0000${turnKey}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
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
