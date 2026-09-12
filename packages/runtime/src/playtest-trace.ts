// @ts-ignore — runtime is pinned to Node 24.19.0 where node:sqlite is built in; no @types/node dependency is installed yet.
import { DatabaseSync } from "node:sqlite";
import {
  cloneJson,
  deepFreeze,
  frozen,
  isJsonValue,
  isNonEmptyPath,
  isPlainObject,
  isRuntimeId,
  isSha256,
  isSafeNonNegativeInteger,
  MAX_PUBLIC_RESPONSE_JSON_CHARS,
  normalizeContentHash
} from "./json-guards.js";
import { sessionSummaryFromColumns, turnEvidenceFromColumns } from "./session-rows.js";
import { SQLiteStorageCorruptionError } from "./sqlite-errors.js";
import type { PinnedReleaseIdentity, RuntimePublicResponse } from "./storage.js";

export const DEFAULT_PLAYTEST_TRACE_SESSION_LIMIT = 20;
export const MAX_PLAYTEST_TRACE_SESSION_LIMIT = 50;
export const DEFAULT_PLAYTEST_TRACE_OPERATION_LIMIT = 100;
export const MAX_PLAYTEST_TRACE_OPERATION_LIMIT = 200;

export interface PlaytestTraceTurnEvidence {
  readonly turnId: string;
  readonly beforeRevision: number;
  readonly afterRevision: number;
  readonly stateHash: string;
}

export interface PlaytestTraceOperationEvidence {
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly status: "completed" | "finished_without_turn";
  readonly completionKind: "turn" | "without_turn";
  readonly turn: PlaytestTraceTurnEvidence | null;
  readonly publicResponse: RuntimePublicResponse;
}

export interface PlaytestTraceSessionEvidence {
  readonly sessionId: string;
  readonly currentRevision: number;
  readonly operations: readonly PlaytestTraceOperationEvidence[];
  readonly hasMoreOperations: boolean;
}

export interface PlaytestRuntimeTrace {
  readonly runtimePinnedRelease: PinnedReleaseIdentity;
  readonly sessions: readonly PlaytestTraceSessionEvidence[];
  readonly hasMoreSessions: boolean;
}

export interface ReadPlaytestTraceInput extends PinnedReleaseIdentity {
  readonly sessionLimit?: number;
  readonly operationLimitPerSession?: number;
}

export interface PlaytestTraceReader {
  readPlaytestTrace(input: ReadPlaytestTraceInput): Promise<PlaytestRuntimeTrace>;
}

export interface SQLitePlaytestTraceReaderOptions {
  readonly path: string;
}

/**
 * Read-only evidence adapter over already-persisted Runtime rows. It does not
 * authenticate guests, expose credential/idempotency/fencing material, or
 * execute/reconstruct gameplay. Absence of Runtime tables means no launched
 * Runtime evidence yet, not a fabricated trace.
 */
export class SQLitePlaytestTraceReader implements PlaytestTraceReader {
  readonly #db: any;
  #closed = false;

  constructor(options: SQLitePlaytestTraceReaderOptions) {
    if (!isNonEmptyPath(options.path)) {
      throw new TypeError("SQLite path is required");
    }
    this.#db = new DatabaseSync(options.path, {
      readOnly: false,
      defensive: true,
      enableForeignKeyConstraints: true,
      allowExtension: false
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }

  async readPlaytestTrace(input: ReadPlaytestTraceInput): Promise<PlaytestRuntimeTrace> {
    this.#assertOpen();
    if (!isRuntimeId(input.questId) || !isRuntimeId(input.releaseId) || !isSha256(input.contentHash)) {
      throw new TypeError("invalid pinned playtest release identity");
    }
    const sessionLimit = boundedLimit(
      input.sessionLimit,
      DEFAULT_PLAYTEST_TRACE_SESSION_LIMIT,
      MAX_PLAYTEST_TRACE_SESSION_LIMIT,
      "sessionLimit"
    );
    const operationLimit = boundedLimit(
      input.operationLimitPerSession,
      DEFAULT_PLAYTEST_TRACE_OPERATION_LIMIT,
      MAX_PLAYTEST_TRACE_OPERATION_LIMIT,
      "operationLimitPerSession"
    );
    const release = frozen({
      questId: input.questId,
      releaseId: input.releaseId,
      contentHash: normalizeContentHash(input.contentHash)
    });

    const tableState = this.#runtimeTableState();
    if (tableState === "absent") {
      return frozen({ runtimePinnedRelease: release, sessions: Object.freeze([]), hasMoreSessions: false });
    }
    if (tableState !== "complete") {
      throw new SQLiteStorageCorruptionError("runtime trace tables are only partially present");
    }

    const sessionRows = this.#db.prepare(`
      SELECT session_id, revision
      FROM sessions
      WHERE quest_id = ? AND release_id = ? AND content_hash = ?
      ORDER BY session_id ASC
      LIMIT ?
    `).all(release.questId, release.releaseId, release.contentHash, sessionLimit + 1);
    const hasMoreSessions = sessionRows.length > sessionLimit;
    const sessions: PlaytestTraceSessionEvidence[] = [];

    for (const row of sessionRows.slice(0, sessionLimit)) {
      const { sessionId, currentRevision } = sessionSummaryFromColumns(row);
      const operationRows = this.#db.prepare(`
        SELECT o.operation_id, o.expected_revision, o.status, o.completion_kind,
               o.turn_id, o.public_response_json,
               t.before_revision, t.after_revision, t.state_hash
        FROM operations o
        LEFT JOIN turns t ON t.operation_id = o.operation_id
        WHERE o.session_id = ?
          AND o.status IN ('completed', 'finished_without_turn')
        ORDER BY o.rowid ASC
        LIMIT ?
      `).all(sessionId, operationLimit + 1);
      const hasMoreOperations = operationRows.length > operationLimit;
      const operations = operationRows.slice(0, operationLimit).map((operationRow: any) =>
        operationEvidenceFromRow(operationRow, sessionId)
      );
      sessions.push(frozen({
        sessionId,
        currentRevision,
        operations: Object.freeze(operations),
        hasMoreOperations
      }));
    }

    return frozen({
      runtimePinnedRelease: release,
      sessions: Object.freeze(sessions),
      hasMoreSessions
    });
  }

  #runtimeTableState(): "absent" | "partial" | "complete" {
    const rows = this.#db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('sessions', 'operations', 'turns')
    `).all();
    const names = new Set(rows.map((row: any) => String(row.name)));
    if (names.size === 0) return "absent";
    return names.size === 3 ? "complete" : "partial";
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("SQLitePlaytestTraceReader is closed");
  }
}

/**
 * DIVERGENT from `session-rows.ts#operationRecordFromColumns`: this projection is
 * evidence (no idempotency/request/fencing material) and admits only the two
 * historical statuses, so it is intentionally not unified with the storage mapper.
 */
function operationEvidenceFromRow(row: any, expectedSessionId: string): PlaytestTraceOperationEvidence {
  const operationId = String(row.operation_id);
  const expectedRevision = Number(row.expected_revision);
  const status = String(row.status);
  const completionKind = String(row.completion_kind);
  if (!isRuntimeId(operationId)
    || !isSafeNonNegativeInteger(expectedRevision)
    || (status !== "completed" && status !== "finished_without_turn")
    || (completionKind !== "turn" && completionKind !== "without_turn")) {
    throw new SQLiteStorageCorruptionError(`invalid completed operation row for ${expectedSessionId}`);
  }
  if (typeof row.public_response_json !== "string"
    || row.public_response_json.length > MAX_PUBLIC_RESPONSE_JSON_CHARS) {
    throw new SQLiteStorageCorruptionError("completed operation has invalid public response evidence");
  }
  const parsed = parseJson(row.public_response_json, "runtime public response");
  if (!isPublicResponse(parsed)) {
    throw new SQLiteStorageCorruptionError("completed operation public response is outside runtime bounds");
  }

  let turn: PlaytestTraceTurnEvidence | null = null;
  if (completionKind === "turn") {
    turn = frozen(turnEvidenceFromColumns(row));
  } else if (row.turn_id !== null || row.before_revision !== null || row.after_revision !== null || row.state_hash !== null) {
    throw new SQLiteStorageCorruptionError("without-turn operation unexpectedly has turn evidence");
  }

  return frozen({
    operationId,
    expectedRevision,
    status,
    completionKind,
    turn,
    publicResponse: deepFreeze(cloneJson(parsed as RuntimePublicResponse))
  });
}

function boundedLimit(value: unknown, fallback: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new RangeError(`${label} outside bounds`);
  }
  return value as number;
}

/**
 * DIVERGENT from `json-guards.ts#isPublicResponse`: no serialized-size bound here,
 * because the raw TEXT column length is already bounded by the caller above.
 */
function isPublicResponse(value: unknown): value is RuntimePublicResponse {
  return isPlainObject(value) && isJsonValue(value, 0);
}

/**
 * DIVERGENT from `json-guards.ts#parseJsonColumn`: callers here pre-check
 * `typeof ... === "string"`, and this variant intentionally omits the "is not
 * text" branch (JSON.parse would coerce a non-string instead of throwing).
 */
function parseJson(value: string, label: string): unknown {
  try { return JSON.parse(value); } catch { throw new SQLiteStorageCorruptionError(`${label} is invalid JSON`); }
}
