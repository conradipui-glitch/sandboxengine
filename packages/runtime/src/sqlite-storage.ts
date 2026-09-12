// @ts-ignore — runtime is pinned to Node 24.19.0 where node:sqlite is built in; no @types/node dependency is installed yet.
import { DatabaseSync } from "node:sqlite";
import {
  cloneAndFreeze,
  frozen,
  canonicalRequestHash,
  isLeaseEndSafe,
  isNonEmptyPath,
  isPositiveSafeInteger,
  isPublicResponse,
  isRuntimeId,
  isSafeNonNegativeInteger,
  isValidCandidateState,
  isValidClaimInput,
  isValidRenewInput,
  isValidSeedSession,
  isValidTurnRecord,
  parseJsonColumn
} from "./json-guards.js";
import type { ServiceClock } from "./service-clock.js";
import {
  OPERATION_ROW_COLUMNS,
  SESSION_INSERT_SQL,
  SESSION_ROW_COLUMNS,
  SESSION_ROW_COLUMNS_WITH_FENCING,
  nullableString,
  operationRecordFromColumns,
  sessionInsertParameters,
  sessionRecordFromColumns
} from "./session-rows.js";
import {
  SQLiteStorageBusyError,
  SQLiteStorageCorruptionError,
  normalizeSQLiteError
} from "./sqlite-errors.js";
import type {
  ClaimOperationInput,
  ClaimOperationResult,
  CommitTurnInput,
  CommitTurnResult,
  FinishWithoutTurnInput,
  FinishWithoutTurnResult,
  OperationRecord,
  RenewLeaseInput,
  RenewLeaseResult,
  RuntimeStorage,
  SessionRecord,
  TurnRecordBoundary
} from "./storage.js";

// Error types moved to sqlite-errors.ts; re-exported here so the package public
// API (index.ts imports them from this module) and existing importers are unchanged.
export { SQLiteStorageBusyError, SQLiteStorageCorruptionError } from "./sqlite-errors.js";

const SQLITE_SCHEMA_VERSION = 1;
export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 50;
export const MAX_SQLITE_BUSY_TIMEOUT_MS = 5_000;

export type SQLiteFaultPoint = "commitTurn.beforeCommit" | "finishWithoutTurn.beforeCommit";
export type SQLiteFaultInjector = (point: SQLiteFaultPoint) => void;

export interface SQLiteRuntimeStorageOptions {
  readonly path: string;
  readonly clock: ServiceClock;
  readonly sessions?: readonly SessionRecord[];
  readonly busyTimeoutMs?: number;
  readonly faultInjector?: SQLiteFaultInjector;
}

/**
 * Durable B04 RuntimeStorage adapter. It reproduces Memory semantics using
 * short SQLite transactions; no Core work is executed while a write lock is held.
 */
export class SQLiteRuntimeStorage implements RuntimeStorage {
  readonly #db: any;
  readonly #clock: ServiceClock;
  readonly #faultInjector?: SQLiteFaultInjector;
  #closed = false;

  constructor(options: SQLiteRuntimeStorageOptions) {
    if (!isNonEmptyPath(options.path)) throw new TypeError("SQLite path is required");
    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
    if (!isSafeNonNegativeInteger(busyTimeoutMs) || busyTimeoutMs > MAX_SQLITE_BUSY_TIMEOUT_MS) {
      throw new RangeError("busyTimeoutMs is outside the bounded policy");
    }
    this.#clock = options.clock;
    this.#serviceNow();
    this.#faultInjector = options.faultInjector;
    this.#db = new DatabaseSync(options.path, {
      timeout: busyTimeoutMs,
      defensive: true,
      enableForeignKeyConstraints: true,
      allowExtension: false
    });
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.#initializeSchema();
    for (const session of options.sessions ?? []) this.#seedSession(session);
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }

  async loadSession(sessionId: string): Promise<SessionRecord | null> {
    this.#assertOpen();
    if (!isRuntimeId(sessionId)) return null;
    const row = this.#db.prepare(`
      SELECT ${SESSION_ROW_COLUMNS}
      FROM sessions WHERE session_id = ?
    `).get(sessionId);
    return row ? sessionRecordFromColumns(row) : null;
  }

  async getOperation(sessionId: string, operationId: string): Promise<OperationRecord | null> {
    this.#assertOpen();
    if (!isRuntimeId(sessionId) || !isRuntimeId(operationId)) return null;
    const row = this.#db.prepare(`
      SELECT ${OPERATION_ROW_COLUMNS}
      FROM operations WHERE session_id = ? AND operation_id = ?
    `).get(sessionId, operationId);
    return row ? operationRecordFromColumns(row) : null;
  }

  async claimOperation(input: ClaimOperationInput): Promise<ClaimOperationResult> {
    this.#assertOpen();
    const now = this.#serviceNow();
    if (!isValidClaimInput(input) || !isLeaseEndSafe(now, input.leaseDurationMs)) {
      return frozen({ kind: "invalid_request" });
    }

    return this.#transaction(() => {
      const sessionRow = this.#getSessionRow(input.sessionId);
      if (!sessionRow) return frozen({ kind: "session_not_found" });
      const session = sessionRecordFromColumns(sessionRow);
      const requestHash = canonicalRequestHash(input.requestHash);
      const existingRow = this.#db.prepare(`
        SELECT ${OPERATION_ROW_COLUMNS}
        FROM operations WHERE session_id = ? AND idempotency_key = ?
      `).get(input.sessionId, input.idempotencyKey);

      if (existingRow) {
        const existing = operationRecordFromColumns(existingRow);
        if (existing.requestHash !== requestHash || existing.expectedRevision !== input.expectedRevision) {
          return frozen({ kind: "idempotency_key_reused", operationId: existing.operationId });
        }
        if (existing.status !== "processing") {
          if (existing.publicResponse === null) throw new SQLiteStorageCorruptionError("completed operation has no public response");
          return frozen({ kind: "replay", operation: existing, publicResponse: existing.publicResponse });
        }
        if (existing.leaseExpiresAtMs !== null && now < existing.leaseExpiresAtMs) {
          return frozen({ kind: "processing", operation: existing });
        }
        if (session.revision !== input.expectedRevision) {
          return frozen({ kind: "revision_conflict", currentRevision: session.revision });
        }
        if (session.activeOperationId !== null && session.activeOperationId !== existing.operationId) {
          return frozen({ kind: "action_in_progress", operationId: session.activeOperationId });
        }

        const fencingToken = nextFencingToken(Number(sessionRow.fencing_counter));
        if (fencingToken === null) return frozen({ kind: "invalid_request" });
        this.#db.prepare(`
          UPDATE sessions SET active_operation_id = ?, fencing_counter = ? WHERE session_id = ?
        `).run(existing.operationId, fencingToken, input.sessionId);
        this.#db.prepare(`
          UPDATE operations SET lease_expires_at_ms = ?, fencing_token = ? WHERE operation_id = ?
        `).run(now + input.leaseDurationMs, fencingToken, existing.operationId);
        const operation = frozen({
          ...existing,
          leaseExpiresAtMs: now + input.leaseDurationMs,
          fencingToken
        });
        return frozen({ kind: "acquired", operation, reacquired: true });
      }

      if (session.revision !== input.expectedRevision) {
        return frozen({ kind: "revision_conflict", currentRevision: session.revision });
      }
      if (session.activeOperationId !== null) {
        return frozen({ kind: "action_in_progress", operationId: session.activeOperationId });
      }

      const fencingToken = nextFencingToken(Number(sessionRow.fencing_counter));
      if (fencingToken === null) return frozen({ kind: "invalid_request" });
      const operationId = this.#nextOperationId();
      const leaseExpiresAtMs = now + input.leaseDurationMs;
      this.#db.prepare(`
        INSERT INTO operations (
          operation_id, session_id, idempotency_key, request_hash, expected_revision,
          status, lease_expires_at_ms, fencing_token, completion_kind, turn_id, public_response_json
        ) VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, NULL, NULL, NULL)
      `).run(
        operationId,
        input.sessionId,
        input.idempotencyKey,
        requestHash,
        input.expectedRevision,
        leaseExpiresAtMs,
        fencingToken
      );
      this.#db.prepare(`
        UPDATE sessions SET active_operation_id = ?, fencing_counter = ? WHERE session_id = ?
      `).run(operationId, fencingToken, input.sessionId);

      const operation: OperationRecord = frozen({
        operationId,
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        expectedRevision: input.expectedRevision,
        status: "processing",
        leaseExpiresAtMs,
        fencingToken,
        completionKind: null,
        turnId: null,
        publicResponse: null
      });
      return frozen({ kind: "acquired", operation, reacquired: false });
    });
  }

  async renewLease(input: RenewLeaseInput): Promise<RenewLeaseResult> {
    this.#assertOpen();
    const now = this.#serviceNow();
    if (!isValidRenewInput(input) || !isLeaseEndSafe(now, input.leaseDurationMs)) {
      return frozen({ kind: "invalid_request" });
    }

    return this.#transaction(() => {
      const sessionRow = this.#getSessionRow(input.sessionId);
      if (!sessionRow) return frozen({ kind: "session_not_found" });
      const operationRow = this.#getOperationRow(input.sessionId, input.operationId);
      if (!operationRow) return frozen({ kind: "operation_not_found" });
      const operation = operationRecordFromColumns(operationRow);
      if (operation.status !== "processing") return frozen({ kind: "operation_not_processing" });
      if (nullableString(sessionRow.active_operation_id) !== operation.operationId) return frozen({ kind: "operation_not_active" });
      if (operation.fencingToken !== input.fencingToken) return frozen({ kind: "stale_fencing_token" });
      if (operation.leaseExpiresAtMs === null || now >= operation.leaseExpiresAtMs) return frozen({ kind: "lease_expired" });

      const leaseExpiresAtMs = now + input.leaseDurationMs;
      this.#db.prepare("UPDATE operations SET lease_expires_at_ms = ? WHERE operation_id = ?")
        .run(leaseExpiresAtMs, operation.operationId);
      return frozen({ kind: "renewed", operation: frozen({ ...operation, leaseExpiresAtMs }) });
    });
  }

  async commitTurn(input: CommitTurnInput): Promise<CommitTurnResult> {
    this.#assertOpen();
    const now = this.#serviceNow();
    if (!isRuntimeId(input.sessionId) || !isRuntimeId(input.operationId)
      || !isSafeNonNegativeInteger(input.expectedRevision) || !isPositiveSafeInteger(input.fencingToken)) {
      return frozen({ kind: "invalid_request" });
    }

    return this.#transaction(() => {
      const sessionRow = this.#getSessionRow(input.sessionId);
      if (!sessionRow) return frozen({ kind: "session_not_found" });
      const session = sessionRecordFromColumns(sessionRow);
      const operationRow = this.#getOperationRow(input.sessionId, input.operationId);
      if (!operationRow) return frozen({ kind: "operation_not_found" });
      const operation = operationRecordFromColumns(operationRow);
      if (operation.status !== "processing") return frozen({ kind: "operation_not_processing" });
      if (session.revision !== input.expectedRevision || operation.expectedRevision !== input.expectedRevision) {
        return frozen({ kind: "revision_conflict", currentRevision: session.revision });
      }
      if (session.activeOperationId !== operation.operationId) return frozen({ kind: "operation_not_active" });
      if (operation.fencingToken !== input.fencingToken) return frozen({ kind: "stale_fencing_token" });
      if (operation.leaseExpiresAtMs === null || now >= operation.leaseExpiresAtMs) return frozen({ kind: "lease_expired" });
      if (!isValidCandidateState(input.candidateState, input.expectedRevision)) return frozen({ kind: "invalid_candidate_state" });
      if (!isValidTurnRecord(input.turnRecord, operation, input.expectedRevision) || this.#turnExists(input.turnRecord.turnId)) {
        return frozen({ kind: "invalid_turn_record" });
      }
      if (!isPublicResponse(input.publicResponse)) return frozen({ kind: "invalid_public_response" });

      const stateJson = JSON.stringify(input.candidateState);
      const turnJson = JSON.stringify(input.turnRecord);
      const responseJson = JSON.stringify(input.publicResponse);
      this.#db.prepare(`
        UPDATE sessions SET state_json = ?, revision = ?, active_operation_id = NULL WHERE session_id = ?
      `).run(stateJson, input.candidateState.revision, input.sessionId);
      this.#db.prepare(`
        INSERT INTO turns (turn_id, operation_id, session_id, before_revision, after_revision, state_hash, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.turnRecord.turnId,
        input.turnRecord.operationId,
        input.turnRecord.sessionId,
        input.turnRecord.beforeRevision,
        input.turnRecord.afterRevision,
        input.turnRecord.stateHash.toLowerCase(),
        turnJson
      );
      this.#db.prepare(`
        UPDATE operations
        SET status = 'completed', lease_expires_at_ms = NULL, completion_kind = 'turn', turn_id = ?, public_response_json = ?
        WHERE operation_id = ?
      `).run(input.turnRecord.turnId, responseJson, input.operationId);
      this.#faultInjector?.("commitTurn.beforeCommit");

      const nextSession = frozen({
        ...session,
        state: cloneAndFreeze(input.candidateState),
        revision: input.candidateState.revision,
        activeOperationId: null
      });
      const nextOperation = frozen({
        ...operation,
        status: "completed" as const,
        leaseExpiresAtMs: null,
        completionKind: "turn" as const,
        turnId: input.turnRecord.turnId,
        publicResponse: cloneAndFreeze(input.publicResponse)
      });
      return frozen({ kind: "committed", session: nextSession, operation: nextOperation });
    });
  }

  async finishWithoutTurn(input: FinishWithoutTurnInput): Promise<FinishWithoutTurnResult> {
    this.#assertOpen();
    const now = this.#serviceNow();
    if (!isRuntimeId(input.sessionId) || !isRuntimeId(input.operationId)
      || !isSafeNonNegativeInteger(input.expectedRevision) || !isPositiveSafeInteger(input.fencingToken)) {
      return frozen({ kind: "invalid_request" });
    }

    return this.#transaction(() => {
      const sessionRow = this.#getSessionRow(input.sessionId);
      if (!sessionRow) return frozen({ kind: "session_not_found" });
      const session = sessionRecordFromColumns(sessionRow);
      const operationRow = this.#getOperationRow(input.sessionId, input.operationId);
      if (!operationRow) return frozen({ kind: "operation_not_found" });
      const operation = operationRecordFromColumns(operationRow);
      if (operation.status !== "processing") return frozen({ kind: "operation_not_processing" });
      if (session.revision !== input.expectedRevision || operation.expectedRevision !== input.expectedRevision) {
        return frozen({ kind: "revision_conflict", currentRevision: session.revision });
      }
      if (session.activeOperationId !== operation.operationId) return frozen({ kind: "operation_not_active" });
      if (operation.fencingToken !== input.fencingToken) return frozen({ kind: "stale_fencing_token" });
      if (operation.leaseExpiresAtMs === null || now >= operation.leaseExpiresAtMs) return frozen({ kind: "lease_expired" });
      if (!isPublicResponse(input.publicResponse)) return frozen({ kind: "invalid_public_response" });

      const responseJson = JSON.stringify(input.publicResponse);
      this.#db.prepare("UPDATE sessions SET active_operation_id = NULL WHERE session_id = ?").run(input.sessionId);
      this.#db.prepare(`
        UPDATE operations
        SET status = 'finished_without_turn', lease_expires_at_ms = NULL,
            completion_kind = 'without_turn', turn_id = NULL, public_response_json = ?
        WHERE operation_id = ?
      `).run(responseJson, input.operationId);
      this.#faultInjector?.("finishWithoutTurn.beforeCommit");

      const nextOperation = frozen({
        ...operation,
        status: "finished_without_turn" as const,
        leaseExpiresAtMs: null,
        completionKind: "without_turn" as const,
        turnId: null,
        publicResponse: cloneAndFreeze(input.publicResponse)
      });
      return frozen({
        kind: "finished",
        session: frozen({ ...session, activeOperationId: null }),
        operation: nextOperation
      });
    });
  }

  inspectTurnsForTest(sessionId: string): readonly TurnRecordBoundary[] {
    this.#assertOpen();
    const rows = this.#db.prepare("SELECT record_json FROM turns WHERE session_id = ? ORDER BY rowid").all(sessionId);
    return Object.freeze(rows.map((row: any) => cloneAndFreeze(parseJsonColumn(row.record_json, "turn record")) as TurnRecordBoundary));
  }

  #initializeSchema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        quest_id TEXT NOT NULL,
        release_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        state_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        active_operation_id TEXT NULL,
        fencing_counter INTEGER NOT NULL DEFAULT 0 CHECK (fencing_counter >= 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
        status TEXT NOT NULL CHECK (status IN ('processing','completed','finished_without_turn')),
        lease_expires_at_ms INTEGER NULL,
        fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
        completion_kind TEXT NULL CHECK (completion_kind IS NULL OR completion_kind IN ('turn','without_turn')),
        turn_id TEXT NULL,
        public_response_json TEXT NULL,
        UNIQUE (session_id, idempotency_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS turns (
        turn_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id),
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        before_revision INTEGER NOT NULL,
        after_revision INTEGER NOT NULL,
        state_hash TEXT NOT NULL,
        record_json TEXT NOT NULL
      ) STRICT;
    `);
    this.#transaction(() => {
      const schema = this.#db.prepare("SELECT value FROM runtime_meta WHERE key = 'schema_version'").get();
      if (!schema) {
        this.#db.prepare("INSERT INTO runtime_meta (key, value) VALUES ('schema_version', ?)").run(SQLITE_SCHEMA_VERSION);
      } else if (Number(schema.value) !== SQLITE_SCHEMA_VERSION) {
        throw new SQLiteStorageCorruptionError(`unsupported runtime schema version ${String(schema.value)}`);
      }
      this.#db.prepare("INSERT OR IGNORE INTO runtime_meta (key, value) VALUES ('operation_counter', 0)").run();
    });
  }

  #seedSession(session: SessionRecord): void {
    if (!isValidSeedSession(session)) throw new TypeError("invalid seed session");
    this.#transaction(() => {
      const existing = this.#getSessionRow(session.sessionId);
      if (existing) {
        const current = sessionRecordFromColumns(existing);
        if (JSON.stringify(current) !== JSON.stringify(session)) {
          throw new SQLiteStorageCorruptionError(`seed session ${session.sessionId} already exists with different state`);
        }
        return;
      }
      this.#db.prepare(SESSION_INSERT_SQL).run(...sessionInsertParameters(session));
    });
  }

  #getSessionRow(sessionId: string): any | undefined {
    return this.#db.prepare(`
      SELECT ${SESSION_ROW_COLUMNS_WITH_FENCING}
      FROM sessions WHERE session_id = ?
    `).get(sessionId);
  }

  #getOperationRow(sessionId: string, operationId: string): any | undefined {
    return this.#db.prepare(`
      SELECT ${OPERATION_ROW_COLUMNS}
      FROM operations WHERE session_id = ? AND operation_id = ?
    `).get(sessionId, operationId);
  }

  #nextOperationId(): string {
    const row = this.#db.prepare("SELECT value FROM runtime_meta WHERE key = 'operation_counter'").get();
    const current = Number(row?.value ?? -1);
    if (!isSafeNonNegativeInteger(current) || current === Number.MAX_SAFE_INTEGER) {
      throw new SQLiteStorageCorruptionError("operation counter invalid or exhausted");
    }
    const next = current + 1;
    this.#db.prepare("UPDATE runtime_meta SET value = ? WHERE key = 'operation_counter'").run(next);
    return `op-${next}`;
  }

  #turnExists(turnId: string): boolean {
    return Boolean(this.#db.prepare("SELECT 1 AS found FROM turns WHERE turn_id = ?").get(turnId));
  }

  #serviceNow(): number {
    const now = this.#clock.nowMs();
    if (!isSafeNonNegativeInteger(now)) throw new RangeError("ServiceClock returned invalid time");
    return now;
  }

  #transaction<T>(work: () => T): T {
    this.#assertOpen();
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
    if (this.#closed) throw new Error("SQLiteRuntimeStorage is closed");
  }
}

/**
 * DIVERGENT from `memory-storage.ts#nextFencingToken(session)`: the SQLite copy
 * re-validates the counter it just read from a row (`isSafeNonNegativeInteger`),
 * so the two are intentionally not unified.
 */
function nextFencingToken(current: number): number | null {
  if (!isSafeNonNegativeInteger(current) || current === Number.MAX_SAFE_INTEGER) return null;
  return current + 1;
}
