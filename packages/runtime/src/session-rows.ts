import type { WorldState } from "@living-history/contracts";
import {
  cloneAndFreeze,
  isRuntimeId,
  isSafeNonNegativeInteger,
  isSha256,
  isValidSeedSession,
  normalizeContentHash,
  parseJsonColumn
} from "./json-guards.js";
import { SQLiteStorageCorruptionError } from "./sqlite-errors.js";
import type { OperationRecord, PinnedReleaseIdentity, RuntimePublicResponse, SessionRecord } from "./storage.js";

/**
 * Shared row <-> record mapping for the SQLite Runtime adapters.
 *
 * Only mappings that were byte-identical between `sqlite-storage.ts`,
 * `sqlite-guest-session-access.ts` and `playtest-trace.ts` live here. Projections
 * that diverge by design stay in their own module with a `DIVERGENT` note —
 * notably the trace reader's operation evidence (no idempotency/request/fencing
 * material, narrower status enum) is intentionally NOT merged into
 * `operationRecordFromColumns` below.
 */

/** Column list of a full `sessions` row (without the fencing counter). */
export const SESSION_ROW_COLUMNS =
  "session_id, quest_id, release_id, content_hash, state_json, revision, active_operation_id";

/** Column list including the fencing counter, needed by claim/reacquire paths. */
export const SESSION_ROW_COLUMNS_WITH_FENCING = `${SESSION_ROW_COLUMNS}, fencing_counter`;

/** Column list of a full `operations` row, shared by every runtime adapter query. */
export const OPERATION_ROW_COLUMNS =
  "operation_id, session_id, idempotency_key, request_hash, expected_revision, "
  + "status, lease_expires_at_ms, fencing_token, completion_kind, turn_id, public_response_json";

/**
 * Canonical session INSERT, shared by runtime seeding and guest session creation.
 * `active_operation_id` is always NULL and `fencing_counter` always 0 at creation.
 */
export const SESSION_INSERT_SQL = `INSERT INTO sessions (
  session_id, quest_id, release_id, content_hash, state_json, revision,
  active_operation_id, fencing_counter
) VALUES (?, ?, ?, ?, ?, ?, NULL, 0)`;

/** Positional parameters for `SESSION_INSERT_SQL` — one source for hash casing and state encoding. */
export function sessionInsertParameters(session: SessionRecord): readonly [string, string, string, string, string, number] {
  return [
    session.sessionId,
    session.release.questId,
    session.release.releaseId,
    normalizeContentHash(session.release.contentHash),
    JSON.stringify(session.state),
    session.revision
  ];
}

/** Coerce a nullable TEXT column to `string | null` (was duplicated verbatim in three modules). */
export function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** Release identity columns -> pinned identity, with the content hash normalized to lower case. */
export function releaseIdentityFromColumns(row: any): PinnedReleaseIdentity {
  return {
    questId: String(row.quest_id),
    releaseId: String(row.release_id),
    contentHash: normalizeContentHash(String(row.content_hash))
  };
}

/** Full `sessions` row -> validated, deep-frozen `SessionRecord`. */
export function sessionRecordFromColumns(row: any): SessionRecord {
  const state = parseJsonColumn(row.state_json, "session state") as WorldState;
  const session: SessionRecord = {
    sessionId: String(row.session_id),
    release: releaseIdentityFromColumns(row),
    state,
    revision: Number(row.revision),
    activeOperationId: nullableString(row.active_operation_id)
  };
  if (!isValidSeedSession({ ...session, activeOperationId: null }) || state.revision !== session.revision) {
    throw new SQLiteStorageCorruptionError(`invalid session row ${session.sessionId}`);
  }
  return cloneAndFreeze(session);
}

/** A `sessions` row projected to the id/revision summary the playtest trace reader reads. */
export function sessionSummaryFromColumns(row: any): {
  readonly sessionId: string;
  readonly currentRevision: number;
} {
  const sessionId = String(row.session_id);
  const currentRevision = Number(row.revision);
  if (!isRuntimeId(sessionId) || !isSafeNonNegativeInteger(currentRevision)) {
    throw new SQLiteStorageCorruptionError("invalid session row in playtest trace");
  }
  return { sessionId, currentRevision };
}

/**
 * Full `operations` row -> validated, deep-frozen `OperationRecord`.
 *
 * DIVERGENT from `playtest-trace.ts#operationEvidenceFromRow`, which accepts only
 * the two historical statuses and omits idempotency/request/fencing fields; the
 * two mappings are deliberately not unified.
 */
export function operationRecordFromColumns(row: any): OperationRecord {
  const status = String(row.status);
  if (status !== "processing" && status !== "completed" && status !== "finished_without_turn") {
    throw new SQLiteStorageCorruptionError("invalid operation status");
  }
  const completionKindRaw = nullableString(row.completion_kind);
  if (completionKindRaw !== null && completionKindRaw !== "turn" && completionKindRaw !== "without_turn") {
    throw new SQLiteStorageCorruptionError("invalid completion kind");
  }
  const response = row.public_response_json === null
    ? null
    : cloneAndFreeze(parseJsonColumn(row.public_response_json, "public response") as RuntimePublicResponse);
  return cloneAndFreeze({
    operationId: String(row.operation_id),
    sessionId: String(row.session_id),
    idempotencyKey: String(row.idempotency_key),
    requestHash: String(row.request_hash),
    expectedRevision: Number(row.expected_revision),
    status,
    leaseExpiresAtMs: row.lease_expires_at_ms === null ? null : Number(row.lease_expires_at_ms),
    fencingToken: Number(row.fencing_token),
    completionKind: completionKindRaw,
    turnId: nullableString(row.turn_id),
    publicResponse: response
  } as OperationRecord);
}

/**
 * `turns` row evidence used by the playtest trace reader (validated, hash lower-cased).
 * Throws the same message the reader raised before extraction.
 */
export function turnEvidenceFromColumns(row: any): {
  readonly turnId: string;
  readonly beforeRevision: number;
  readonly afterRevision: number;
  readonly stateHash: string;
} {
  const turnId = nullableString(row.turn_id);
  const beforeRevision = Number(row.before_revision);
  const afterRevision = Number(row.after_revision);
  const stateHash = nullableString(row.state_hash);
  if (!turnId || !isRuntimeId(turnId)
    || !isSafeNonNegativeInteger(beforeRevision)
    || afterRevision !== beforeRevision + 1
    || !stateHash || !isSha256(stateHash)) {
    throw new SQLiteStorageCorruptionError("completed turn evidence is missing or invalid");
  }
  return { turnId, beforeRevision, afterRevision, stateHash: normalizeContentHash(stateHash) };
}
