import type { JsonValue, WorldState } from "@living-history/contracts";
import { SQLiteStorageCorruptionError } from "./sqlite-errors.js";
import type {
  ClaimOperationInput,
  OperationRecord,
  RenewLeaseInput,
  RuntimePublicResponse,
  SessionRecord,
  TurnRecordBoundary
} from "./storage.js";
import { isValidWorldState } from "./world-state-validation.js";

/**
 * Shared clone/parse/check primitives for the Runtime package.
 *
 * Every function here is byte-for-byte equivalent to the copies that used to
 * live in `memory-storage.ts`, `sqlite-storage.ts`,
 * `sqlite-guest-session-access.ts` and `playtest-trace.ts`. Copies that were
 * NOT equivalent were deliberately left in their original module (see the
 * `DIVERGENT` notes in those files); this module does not hide a semantic
 * difference behind a shared name.
 */

// --- Bounded policy shared by every adapter --------------------------------
// Moved out of `memory-storage.ts`, which re-exports them for the public API.
export const MAX_LEASE_DURATION_MS = 300_000;
export const MAX_PUBLIC_RESPONSE_JSON_CHARS = 100_000;

const MAX_JSON_DEPTH = 20;
const MAX_JSON_COLLECTION_SIZE = 1_000;
const MAX_JSON_KEY_LENGTH = 200;
const MAX_ID_CHARS = 200;
const MAX_PATH_CHARS = 4_096;

// --- Plain JSON / object guards --------------------------------------------

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= MAX_JSON_COLLECTION_SIZE && value.every((entry) => isJsonValue(entry, depth + 1));
  }
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= MAX_JSON_COLLECTION_SIZE
    && entries.every(([key, entry]) => key.length <= MAX_JSON_KEY_LENGTH && isJsonValue(entry, depth + 1));
}

/**
 * Bounded public-response guard used by the Memory and SQLite storage adapters.
 *
 * `playtest-trace.ts` keeps its own unbounded variant on purpose: it validates a
 * raw TEXT column whose length is already bounded before parsing, so imposing the
 * serialized-size check inside the parsed guard would be a redundant second
 * semantics (see the `DIVERGENT` note there).
 */
export function isPublicResponse(value: unknown): value is RuntimePublicResponse {
  if (!isPlainObject(value) || !isJsonValue(value, 0)) return false;
  try {
    return JSON.stringify(value).length <= MAX_PUBLIC_RESPONSE_JSON_CHARS;
  } catch {
    return false;
  }
}

// --- Identifier / scalar / hash guards --------------------------------------

export function isRuntimeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

/**
 * Idempotency keys share the runtime-id character policy exactly. The name is
 * kept separate to document intent at call sites that validate a key.
 */
export function isIdempotencyKey(value: unknown): value is string {
  return isRuntimeId(value);
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-fA-F0-9]{64}$/.test(value);
}

export function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function isNonEmptyPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PATH_CHARS;
}

export function isValidLeaseDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_LEASE_DURATION_MS;
}

export function isLeaseEndSafe(now: number, duration: number): boolean {
  return Number.isSafeInteger(now + duration);
}

// --- Domain record checks shared by Memory and SQLite -----------------------

export function isValidSeedSession(session: SessionRecord): boolean {
  return isRuntimeId(session.sessionId)
    && session.activeOperationId === null
    && isRuntimeId(session.release.questId)
    && isRuntimeId(session.release.releaseId)
    && isSha256(session.release.contentHash)
    && isSafeNonNegativeInteger(session.revision)
    && session.state.revision === session.revision
    && isValidWorldState(session.state);
}

export function isValidClaimInput(input: ClaimOperationInput): boolean {
  return isRuntimeId(input.sessionId)
    && isIdempotencyKey(input.idempotencyKey)
    && isSha256(input.requestHash)
    && isSafeNonNegativeInteger(input.expectedRevision)
    && isValidLeaseDuration(input.leaseDurationMs);
}

export function isValidRenewInput(input: RenewLeaseInput): boolean {
  return isRuntimeId(input.sessionId)
    && isRuntimeId(input.operationId)
    && isPositiveSafeInteger(input.fencingToken)
    && isValidLeaseDuration(input.leaseDurationMs);
}

export function isValidCandidateState(state: WorldState, expectedRevision: number): boolean {
  if (expectedRevision === Number.MAX_SAFE_INTEGER) return false;
  return isValidWorldState(state) && state.revision === expectedRevision + 1;
}

export function isValidTurnRecord(record: TurnRecordBoundary, operation: OperationRecord, expectedRevision: number): boolean {
  return isRuntimeId(record.turnId)
    && record.operationId === operation.operationId
    && record.sessionId === operation.sessionId
    && record.beforeRevision === expectedRevision
    && record.afterRevision === expectedRevision + 1
    && isSha256(record.stateHash);
}

// --- Normalization / cloning ------------------------------------------------

export function canonicalRequestHash(value: string): string {
  return value.toLowerCase();
}

/** Release content hashes are stored and compared in lower case across adapters. */
export function normalizeContentHash(value: string): string {
  return value.toLowerCase();
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

export function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(cloneJson(value));
}

// --- SQLite TEXT column parsing --------------------------------------------

/**
 * Parse a JSON TEXT column, raising the storage corruption error on bad input.
 *
 * `playtest-trace.ts` keeps a divergent parse helper on purpose: its callers
 * pre-check `typeof ... === "string"`, so it does not carry the "is not text"
 * branch, and `JSON.parse` coerces a non-string argument instead of throwing
 * (see the `DIVERGENT` note there).
 */
export function parseJsonColumn(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new SQLiteStorageCorruptionError(`${label} is not text`);
  try {
    return JSON.parse(value);
  } catch {
    throw new SQLiteStorageCorruptionError(`${label} is invalid JSON`);
  }
}
