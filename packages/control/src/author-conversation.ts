// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
import { createHash } from "node:crypto";
// @ts-ignore — Node 24.19.0 provides node:sqlite; repository intentionally has no @types/node dependency yet.
import { DatabaseSync } from "node:sqlite";
import { canonicalStringify } from "@living-history/core";
import type { AuthorAgentJobStore } from "./author-agent-jobs.js";
import { DEFAULT_CONTROL_SQLITE_BUSY_TIMEOUT_MS, type SQLiteControlStoreOptions } from "./sqlite-store.js";

export const MAX_AUTHOR_CONVERSATION_TEXT_CHARS = 20_000;
export const MAX_AUTHOR_CONVERSATION_MESSAGES = 2_000;

export type AuthorConversationRole = "author" | "assistant";

export interface AuthorConversationMessage {
  readonly jobId: string;
  readonly ordinal: number;
  readonly messageId: string;
  readonly role: AuthorConversationRole;
  readonly text: string;
  readonly proposalId: string | null;
  readonly proposalTurnKey: string | null;
  readonly payloadHash: string;
  readonly createdAtMs: number;
}

export interface AppendAuthorConversationMessageInput {
  readonly messageId: string;
  readonly role: AuthorConversationRole;
  readonly text: string;
  readonly proposalId: string | null;
  readonly proposalTurnKey: string | null;
  readonly createdAtMs: number;
}

export type AppendAuthorConversationMessageResult =
  | { readonly kind: "appended"; readonly message: AuthorConversationMessage }
  | { readonly kind: "replay"; readonly message: AuthorConversationMessage }
  | { readonly kind: "job_not_found" }
  | { readonly kind: "message_id_reused" }
  | { readonly kind: "message_limit_exceeded" }
  | { readonly kind: "invalid_request" };

export interface AuthorConversationStore {
  listMessages(jobId: string): Promise<readonly AuthorConversationMessage[] | null>;
  appendMessage(jobId: string, input: AppendAuthorConversationMessageInput): Promise<AppendAuthorConversationMessageResult>;
}

export class MemoryAuthorConversationStore implements AuthorConversationStore {
  readonly #messages = new Map<string, AuthorConversationMessage[]>();
  constructor(readonly jobs: Pick<AuthorAgentJobStore, "getJob">) {}

  async listMessages(jobId: string): Promise<readonly AuthorConversationMessage[] | null> {
    if (!isId(jobId) || !(await this.jobs.getJob(jobId))) return null;
    return deepFreeze((this.#messages.get(jobId) ?? []).map(cloneJson));
  }

  async appendMessage(jobId: string, input: AppendAuthorConversationMessageInput): Promise<AppendAuthorConversationMessageResult> {
    const normalized = normalizeInput(jobId, input);
    if (!normalized) return frozen({ kind: "invalid_request" });
    if (!(await this.jobs.getJob(jobId))) return frozen({ kind: "job_not_found" });
    const messages = this.#messages.get(jobId) ?? [];
    const existing = messages.find((message) => message.messageId === normalized.messageId);
    if (existing) {
      return existing.payloadHash === normalized.payloadHash
        ? frozen({ kind: "replay", message: existing })
        : frozen({ kind: "message_id_reused" });
    }
    if (messages.length >= MAX_AUTHOR_CONVERSATION_MESSAGES) return frozen({ kind: "message_limit_exceeded" });
    const message = messageRecord(jobId, messages.length, normalized);
    messages.push(message);
    this.#messages.set(jobId, messages);
    return frozen({ kind: "appended", message });
  }
}

export class SQLiteAuthorConversationStore implements AuthorConversationStore {
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
      CREATE TABLE IF NOT EXISTS control_author_conversation_messages (
        job_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        message_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('author', 'assistant')),
        text TEXT NOT NULL,
        proposal_id TEXT,
        proposal_turn_key TEXT,
        payload_hash TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        PRIMARY KEY (job_id, message_id),
        UNIQUE (job_id, ordinal),
        FOREIGN KEY (job_id) REFERENCES control_author_agent_jobs(job_id) ON DELETE CASCADE
      ) STRICT;
    `);
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }

  async listMessages(jobId: string): Promise<readonly AuthorConversationMessage[] | null> {
    this.#assertOpen();
    if (!isId(jobId) || !(await this.jobs.getJob(jobId))) return null;
    const rows = this.#db.prepare(`
      SELECT ordinal, message_id, role, text, proposal_id, proposal_turn_key, payload_hash, created_at_ms
      FROM control_author_conversation_messages WHERE job_id = ? ORDER BY ordinal ASC
    `).all(jobId);
    return deepFreeze(rows.map((row: any) => messageFromRow(jobId, row)));
  }

  async appendMessage(jobId: string, input: AppendAuthorConversationMessageInput): Promise<AppendAuthorConversationMessageResult> {
    this.#assertOpen();
    const normalized = normalizeInput(jobId, input);
    if (!normalized) return frozen({ kind: "invalid_request" });
    if (!(await this.jobs.getJob(jobId))) return frozen({ kind: "job_not_found" });
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#readMessage(jobId, normalized.messageId);
      if (existing) {
        this.#db.exec("ROLLBACK");
        return existing.payloadHash === normalized.payloadHash
          ? frozen({ kind: "replay", message: existing })
          : frozen({ kind: "message_id_reused" });
      }
      const countRow = this.#db.prepare(`SELECT COUNT(*) AS count FROM control_author_conversation_messages WHERE job_id = ?`).get(jobId);
      const count = Number(countRow.count);
      if (count >= MAX_AUTHOR_CONVERSATION_MESSAGES) {
        this.#db.exec("ROLLBACK");
        return frozen({ kind: "message_limit_exceeded" });
      }
      const ordinalRow = this.#db.prepare(`SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal FROM control_author_conversation_messages WHERE job_id = ?`).get(jobId);
      const message = messageRecord(jobId, Number(ordinalRow.max_ordinal) + 1, normalized);
      this.#db.prepare(`
        INSERT INTO control_author_conversation_messages
          (job_id, ordinal, message_id, role, text, proposal_id, proposal_turn_key, payload_hash, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        message.jobId, message.ordinal, message.messageId, message.role, message.text,
        message.proposalId, message.proposalTurnKey, message.payloadHash, message.createdAtMs
      );
      this.#db.exec("COMMIT");
      return frozen({ kind: "appended", message });
    } catch (error) {
      safeRollback(this.#db);
      throw error;
    }
  }

  #readMessage(jobId: string, messageId: string): AuthorConversationMessage | null {
    const row = this.#db.prepare(`
      SELECT ordinal, message_id, role, text, proposal_id, proposal_turn_key, payload_hash, created_at_ms
      FROM control_author_conversation_messages WHERE job_id = ? AND message_id = ?
    `).get(jobId, messageId);
    return row ? messageFromRow(jobId, row) : null;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("SQLiteAuthorConversationStore is closed");
  }
}

interface NormalizedMessageInput extends AppendAuthorConversationMessageInput {
  readonly payloadHash: string;
}

function normalizeInput(jobId: string, input: AppendAuthorConversationMessageInput): NormalizedMessageInput | null {
  if (!isId(jobId) || !isId(input?.messageId) || !isRole(input?.role)
    || typeof input?.text !== "string" || input.text.length < 1 || input.text.length > MAX_AUTHOR_CONVERSATION_TEXT_CHARS
    || !(input.proposalId === null || isId(input.proposalId))
    || !(input.proposalTurnKey === null || isHash(input.proposalTurnKey))
    || ((input.proposalId === null) !== (input.proposalTurnKey === null))
    || (input.role === "author" && input.proposalId !== null)
    || !isTimestamp(input.createdAtMs)) return null;
  const payload = {
    role: input.role,
    text: input.text,
    proposalId: input.proposalId,
    proposalTurnKey: input.proposalTurnKey
  };
  return deepFreeze({ ...input, payloadHash: sha256(canonicalStringify(payload)) });
}

function messageRecord(jobId: string, ordinal: number, input: NormalizedMessageInput): AuthorConversationMessage {
  return deepFreeze({
    jobId,
    ordinal,
    messageId: input.messageId,
    role: input.role,
    text: input.text,
    proposalId: input.proposalId,
    proposalTurnKey: input.proposalTurnKey,
    payloadHash: input.payloadHash,
    createdAtMs: input.createdAtMs
  });
}

function messageFromRow(jobId: string, row: any): AuthorConversationMessage {
  const role = String(row.role);
  const value = {
    messageId: String(row.message_id),
    role,
    text: String(row.text),
    proposalId: row.proposal_id === null ? null : String(row.proposal_id),
    proposalTurnKey: row.proposal_turn_key === null ? null : String(row.proposal_turn_key),
    createdAtMs: Number(row.created_at_ms)
  };
  const normalized = normalizeInput(jobId, value as AppendAuthorConversationMessageInput);
  if (!normalized || normalized.payloadHash !== String(row.payload_hash)) throw new Error("corrupt author conversation message");
  const ordinal = Number(row.ordinal);
  if (!isNonNegativeSafeInteger(ordinal)) throw new Error("corrupt author conversation ordinal");
  return messageRecord(jobId, ordinal, normalized);
}

function isRole(value: unknown): value is AuthorConversationRole {
  return value === "author" || value === "assistant";
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
