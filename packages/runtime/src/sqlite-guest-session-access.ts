// @ts-ignore — runtime is pinned to Node 24.19.0 where node:sqlite is built in; no @types/node dependency is installed yet.
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
  MAX_SQLITE_BUSY_TIMEOUT_MS,
  SQLiteStorageBusyError,
  SQLiteStorageCorruptionError
} from "./sqlite-storage.js";
import type {
  CreateGuestSessionInput,
  CreateGuestSessionResult,
  RuntimeGuestSessionAccess
} from "./session-access.js";
import type { SessionRecord } from "./storage.js";
import { isValidWorldState } from "./world-state-validation.js";

const GUEST_ACCESS_SCHEMA_VERSION = 1;

export interface SQLiteGuestSessionAccessOptions {
  readonly path: string;
  readonly busyTimeoutMs?: number;
}

/**
 * Durable guest ownership companion for SQLiteRuntimeStorage.
 * It writes the existing runtime `sessions` row plus a separate verifier row;
 * credential material never becomes part of SessionRecord or WorldState.
 */
export class SQLiteGuestSessionAccess implements RuntimeGuestSessionAccess {
  readonly #db: any;
  #closed = false;

  constructor(options: SQLiteGuestSessionAccessOptions) {
    if (typeof options.path !== "string" || options.path.length < 1 || options.path.length > 4_096) {
      throw new TypeError("SQLite path is required");
    }
    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
    if (!isSafeNonNegativeInteger(busyTimeoutMs) || busyTimeoutMs > MAX_SQLITE_BUSY_TIMEOUT_MS) {
      throw new RangeError("busyTimeoutMs is outside the bounded policy");
    }

    this.#db = new DatabaseSync(options.path, {
      timeout: busyTimeoutMs,
      defensive: true,
      enableForeignKeyConstraints: true,
      allowExtension: false
    });
    this.#initializeSchema();
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }

  async createGuestSession(input: CreateGuestSessionInput): Promise<CreateGuestSessionResult> {
    this.#assertOpen();
    if (!isValidCreateInput(input)) return frozen({ kind: "invalid_request" });

    return this.#transaction(() => {
      const existing = this.#db.prepare("SELECT 1 AS found FROM sessions WHERE session_id = ?").get(input.sessionId);
      if (existing) return frozen({ kind: "session_exists" });

      const stateJson = JSON.stringify(input.initialState);
      this.#db.prepare(`
        INSERT INTO sessions (
          session_id, quest_id, release_id, content_hash, state_json, revision,
          active_operation_id, fencing_counter
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0)
      `).run(
        input.sessionId,
        input.release.questId,
        input.release.releaseId,
        input.release.contentHash.toLowerCase(),
        stateJson,
        input.initialState.revision
      );
      this.#db.prepare(`
        INSERT INTO guest_session_access (session_id, credential_hash) VALUES (?, ?)
      `).run(input.sessionId, input.credentialHash.toLowerCase());

      const session: SessionRecord = frozen({
        sessionId: input.sessionId,
        release: frozen({
          questId: input.release.questId,
          releaseId: input.release.releaseId,
          contentHash: input.release.contentHash.toLowerCase()
        }),
        state: deepFreeze(cloneJson(input.initialState)),
        revision: input.initialState.revision,
        activeOperationId: null
      });
      return frozen({ kind: "created", session });
    });
  }

  async verifyGuestAccess(sessionId: string, credentialHash: string): Promise<boolean> {
    this.#assertOpen();
    if (!isRuntimeId(sessionId) || !isSha256(credentialHash)) return false;
    const row = this.#db.prepare(`
      SELECT credential_hash FROM guest_session_access WHERE session_id = ?
    `).get(sessionId);
    return Boolean(row && String(row.credential_hash) === credentialHash.toLowerCase());
  }

  #initializeSchema(): void {
    const runtimeSchema = this.#db.prepare(`
      SELECT value FROM runtime_meta WHERE key = 'schema_version'
    `).get();
    if (!runtimeSchema) {
      throw new SQLiteStorageCorruptionError("runtime schema must exist before guest access initialization");
    }

    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS guest_session_access (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        credential_hash TEXT NOT NULL
      ) STRICT;
    `);
    this.#transaction(() => {
      const accessSchema = this.#db.prepare(`
        SELECT value FROM runtime_meta WHERE key = 'guest_access_schema_version'
      `).get();
      if (!accessSchema) {
        this.#db.prepare(`
          INSERT INTO runtime_meta (key, value) VALUES ('guest_access_schema_version', ?)
        `).run(GUEST_ACCESS_SCHEMA_VERSION);
      } else if (Number(accessSchema.value) !== GUEST_ACCESS_SCHEMA_VERSION) {
        throw new SQLiteStorageCorruptionError(
          `unsupported guest access schema version ${String(accessSchema.value)}`
        );
      }
    });
  }

  #transaction<T>(work: () => T): T {
    try {
      this.#db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw normalizeSQLiteError(error);
    }
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { /* transaction may already be gone */ }
      throw normalizeSQLiteError(error);
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("SQLiteGuestSessionAccess is closed");
  }
}

function isValidCreateInput(input: CreateGuestSessionInput): boolean {
  return isRuntimeId(input.sessionId)
    && isSha256(input.credentialHash)
    && isRuntimeId(input.release.questId)
    && isRuntimeId(input.release.releaseId)
    && isSha256(input.release.contentHash)
    && isValidWorldState(input.initialState)
    && input.initialState.revision === 0;
}

function isRuntimeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-fA-F0-9]{64}$/.test(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function normalizeSQLiteError(error: unknown): unknown {
  if (error instanceof SQLiteStorageBusyError || error instanceof SQLiteStorageCorruptionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/database is locked|SQLITE_BUSY/i.test(message)) return new SQLiteStorageBusyError(message);
  return error;
}
