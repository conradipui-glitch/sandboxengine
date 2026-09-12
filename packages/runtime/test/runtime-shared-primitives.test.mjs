// Unit tests for the shared Runtime primitives extracted during the
// session-row/JSON-guard de-duplication refactor.
//
// They exercise the edge cases the storage adapters rely on: null/undefined,
// missing row keys, malformed JSON text, and negative/overflowing numbers.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LEASE_DURATION_MS,
  MAX_PUBLIC_RESPONSE_JSON_CHARS,
  canonicalRequestHash,
  cloneAndFreeze,
  cloneJson,
  deepFreeze,
  frozen,
  isIdempotencyKey,
  isJsonValue,
  isLeaseEndSafe,
  isNonEmptyPath,
  isPlainObject,
  isPositiveSafeInteger,
  isPublicResponse,
  isRuntimeId,
  isSafeNonNegativeInteger,
  isSha256,
  isValidCandidateState,
  isValidClaimInput,
  isValidLeaseDuration,
  isValidRenewInput,
  isValidSeedSession,
  isValidTurnRecord,
  normalizeContentHash,
  parseJsonColumn
} from "../dist/json-guards.js";
import { SQLiteStorageCorruptionError } from "../dist/sqlite-errors.js";
import {
  nullableString,
  operationRecordFromColumns,
  releaseIdentityFromColumns,
  sessionInsertParameters,
  sessionRecordFromColumns,
  sessionSummaryFromColumns,
  turnEvidenceFromColumns
} from "../dist/session-rows.js";

const HASH = "a".repeat(64);

function worldState(revision = 0) {
  return {
    schemaVersion: "1.0",
    revision,
    clock: { elapsedSeconds: 0 },
    locations: [{ id: "workshop" }],
    entities: [],
    resources: [],
    items: [],
    terminal: null
  };
}

// --- identifier / scalar guards -------------------------------------------

test("isRuntimeId accepts the character policy and rejects null/empty/oversize", () => {
  assert.equal(isRuntimeId("op-1"), true);
  assert.equal(isRuntimeId("a".repeat(200)), true);
  assert.equal(isRuntimeId("a".repeat(201)), false);
  assert.equal(isRuntimeId(null), false);
  assert.equal(isRuntimeId(undefined), false);
  assert.equal(isRuntimeId(""), false);
  assert.equal(isRuntimeId(".leading-dot"), false);
  assert.equal(isRuntimeId(42), false);
});

test("isIdempotencyKey shares the runtime-id policy", () => {
  assert.equal(isIdempotencyKey("key_1"), true);
  assert.equal(isIdempotencyKey("-bad"), false);
  assert.equal(isIdempotencyKey(null), false);
});

test("isSha256 requires exactly 64 hex chars, case-insensitive", () => {
  assert.equal(isSha256(HASH), true);
  assert.equal(isSha256("A".repeat(64)), true);
  assert.equal(isSha256("a".repeat(63)), false);
  assert.equal(isSha256("g".repeat(64)), false);
  assert.equal(isSha256(null), false);
  assert.equal(isSha256(123), false);
});

test("integer guards reject null, floats, negatives and unsafe values", () => {
  assert.equal(isSafeNonNegativeInteger(0), true);
  assert.equal(isSafeNonNegativeInteger(-1), false);
  assert.equal(isSafeNonNegativeInteger(1.5), false);
  assert.equal(isSafeNonNegativeInteger(Number.MAX_SAFE_INTEGER + 1), false);
  assert.equal(isSafeNonNegativeInteger("5"), false);

  assert.equal(isPositiveSafeInteger(1), true);
  assert.equal(isPositiveSafeInteger(0), false);
  assert.equal(isPositiveSafeInteger(-5), false);
  assert.equal(isPositiveSafeInteger(null), false);
});

test("isNonEmptyPath and isValidLeaseDuration stay inside their bounds", () => {
  assert.equal(isNonEmptyPath("x"), true);
  assert.equal(isNonEmptyPath(""), false);
  assert.equal(isNonEmptyPath("x".repeat(4_097)), false);
  assert.equal(isNonEmptyPath(null), false);

  assert.equal(isValidLeaseDuration(1), true);
  assert.equal(isValidLeaseDuration(MAX_LEASE_DURATION_MS), true);
  assert.equal(isValidLeaseDuration(0), false);
  assert.equal(isValidLeaseDuration(-1), false);
  assert.equal(isValidLeaseDuration(MAX_LEASE_DURATION_MS + 1), false);
  assert.equal(isValidLeaseDuration(undefined), false);
});

test("isLeaseEndSafe rejects overflow past the safe-integer range", () => {
  assert.equal(isLeaseEndSafe(1_000, MAX_LEASE_DURATION_MS), true);
  assert.equal(isLeaseEndSafe(Number.MAX_SAFE_INTEGER, 1), false);
});

// --- JSON shape guards ------------------------------------------------------

test("isPlainObject rejects null, arrays and class instances", () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(new Date()), false);
});

test("isJsonValue accepts JSON scalars and rejects NaN/Infinity and over-deep nests", () => {
  assert.equal(isJsonValue(null), true);
  assert.equal(isJsonValue("x"), true);
  assert.equal(isJsonValue(true), true);
  assert.equal(isJsonValue(0), true);
  assert.equal(isJsonValue(Number.NaN), false);
  assert.equal(isJsonValue(Number.POSITIVE_INFINITY), false);
  assert.equal(isJsonValue({ a: [1, 2, 3] }), true);
  assert.equal(isJsonValue({ a: undefined }), false);

  let deep = 1;
  for (let i = 0; i < 25; i += 1) deep = { next: deep };
  assert.equal(isJsonValue(deep), false);
});

test("isPublicResponse bounds serialized size and rejects non-objects", () => {
  assert.equal(isPublicResponse({ action: { status: "executed" } }), true);
  assert.equal(isPublicResponse(null), false);
  assert.equal(isPublicResponse([]), false);
  assert.equal(isPublicResponse("text"), false);
  assert.equal(isPublicResponse({ blob: "x".repeat(MAX_PUBLIC_RESPONSE_JSON_CHARS + 1) }), false);
});

// --- normalization / cloning ------------------------------------------------

test("hash normalizers lower-case their input", () => {
  assert.equal(canonicalRequestHash("ABCDEF"), "abcdef");
  assert.equal(normalizeContentHash("ABCDEF"), "abcdef");
});

test("cloneJson returns a detached copy; deepFreeze/cloneAndFreeze freeze deeply", () => {
  const source = { a: { b: 1 } };
  const copy = cloneJson(source);
  assert.notEqual(copy, source);
  copy.a.b = 2;
  assert.equal(source.a.b, 1);

  const frozenValue = cloneAndFreeze(source);
  assert.equal(Object.isFrozen(frozenValue), true);
  assert.equal(Object.isFrozen(frozenValue.a), true);
  assert.throws(() => { frozenValue.a.b = 3; }, TypeError);

  const shallow = frozen({ ok: true });
  assert.equal(Object.isFrozen(shallow), true);
  assert.equal(deepFreeze(null), null);
});

// --- SQLite TEXT column parsing ---------------------------------------------

test("parseJsonColumn rejects non-text and malformed JSON with the corruption error", () => {
  assert.throws(() => parseJsonColumn(null, "session state"), (error) => {
    assert.ok(error instanceof SQLiteStorageCorruptionError);
    assert.match(error.message, /session state is not text/);
    return true;
  });
  assert.throws(() => parseJsonColumn("{not json}", "session state"), (error) => {
    assert.ok(error instanceof SQLiteStorageCorruptionError);
    assert.match(error.message, /session state is invalid JSON/);
    return true;
  });
  assert.deepEqual(parseJsonColumn('{"a":1}', "any"), { a: 1 });
});

// --- domain record checks ----------------------------------------------------

test("isValidSeedSession rejects missing keys, bad hash and mismatched revision", () => {
  const good = { sessionId: "s1", release: { questId: "q", releaseId: "r", contentHash: HASH }, state: worldState(0), revision: 0, activeOperationId: null };
  assert.equal(isValidSeedSession(good), true);
  assert.equal(isValidSeedSession({ ...good, sessionId: null }), false);
  assert.equal(isValidSeedSession({ ...good, release: { questId: "q", releaseId: "r", contentHash: "short" } }), false);
  assert.equal(isValidSeedSession({ ...good, revision: 1 }), false);
  assert.equal(isValidSeedSession({ ...good, activeOperationId: "op-1" }), false);
});

test("isValidClaimInput rejects negative revision and bad lease", () => {
  const good = { sessionId: "s1", idempotencyKey: "k", requestHash: HASH, expectedRevision: 0, leaseDurationMs: 100 };
  assert.equal(isValidClaimInput(good), true);
  assert.equal(isValidClaimInput({ ...good, expectedRevision: -1 }), false);
  assert.equal(isValidClaimInput({ ...good, leaseDurationMs: 0 }), false);
  // The guard dereferences its input directly (unchanged behavior): a null input throws.
  assert.throws(() => isValidClaimInput(null), TypeError);
});

test("isValidRenewInput requires a positive fencing token", () => {
  const good = { sessionId: "s1", operationId: "op-1", fencingToken: 1, leaseDurationMs: 100 };
  assert.equal(isValidRenewInput(good), true);
  assert.equal(isValidRenewInput({ ...good, fencingToken: 0 }), false);
  assert.equal(isValidRenewInput({ ...good, fencingToken: -1 }), false);
});

test("isValidCandidateState enforces the +1 revision boundary", () => {
  assert.equal(isValidCandidateState(worldState(1), 0), true);
  assert.equal(isValidCandidateState(worldState(1), 1), false);
  assert.equal(isValidCandidateState(worldState(1), Number.MAX_SAFE_INTEGER), false);
});

test("isValidTurnRecord enforces revision boundaries", () => {
  const operation = { operationId: "op-1", sessionId: "s1" };
  const record = { turnId: "t1", operationId: "op-1", sessionId: "s1", beforeRevision: 0, afterRevision: 1, stateHash: HASH };
  assert.equal(isValidTurnRecord(record, operation, 0), true);
  assert.equal(isValidTurnRecord({ ...record, afterRevision: 2 }, operation, 0), false);
  assert.equal(isValidTurnRecord({ ...record, stateHash: null }, operation, 0), false);
});

// --- session row mapping -----------------------------------------------------

test("nullableString coerces null/undefined to null and keeps other values as text", () => {
  assert.equal(nullableString(null), null);
  assert.equal(nullableString(undefined), null);
  assert.equal(nullableString("x"), "x");
  assert.equal(nullableString(5), "5");
});

test("releaseIdentityFromColumns lower-cases the content hash", () => {
  assert.deepEqual(
    releaseIdentityFromColumns({ quest_id: "q", release_id: "r", content_hash: "ABCD" }),
    { questId: "q", releaseId: "r", contentHash: "abcd" }
  );
});

test("sessionInsertParameters lower-cases the hash and JSON-encodes the state", () => {
  const row = sessionInsertParameters({
    sessionId: "s1",
    release: { questId: "q", releaseId: "r", contentHash: HASH.toUpperCase() },
    state: worldState(0),
    revision: 0,
    activeOperationId: null
  });
  assert.deepEqual(row.slice(0, 4), ["s1", "q", "r", HASH]);
  assert.deepEqual(JSON.parse(row[4]), worldState(0));
  assert.equal(row[5], 0);
});

test("sessionRecordFromColumns validates and freezes, and rejects broken rows", () => {
  const stored = sessionRecordFromColumns({
    session_id: "s1",
    quest_id: "q",
    release_id: "r",
    content_hash: HASH.toUpperCase(),
    state_json: JSON.stringify(worldState(0)),
    revision: 0,
    active_operation_id: null
  });
  assert.equal(stored.sessionId, "s1");
  assert.equal(stored.release.contentHash, HASH);
  assert.equal(Object.isFrozen(stored), true);

  assert.throws(
    () => sessionRecordFromColumns({ session_id: "s1", quest_id: "q", release_id: "r", content_hash: HASH, state_json: "{oops", revision: 0, active_operation_id: null }),
    (error) => error instanceof SQLiteStorageCorruptionError && /session state is invalid JSON/.test(error.message)
  );
  assert.throws(
    () => sessionRecordFromColumns({ session_id: null, quest_id: null, release_id: null, content_hash: null, state_json: JSON.stringify(worldState(0)), revision: 0, active_operation_id: null }),
    (error) => error instanceof SQLiteStorageCorruptionError && /invalid session row/.test(error.message)
  );
});

test("sessionSummaryFromColumns rejects negative revision and missing id", () => {
  assert.deepEqual(sessionSummaryFromColumns({ session_id: "s1", revision: 3 }), { sessionId: "s1", currentRevision: 3 });
  assert.throws(
    () => sessionSummaryFromColumns({ session_id: "s1", revision: -1 }),
    (error) => error instanceof SQLiteStorageCorruptionError && /invalid session row in playtest trace/.test(error.message)
  );
  assert.throws(() => sessionSummaryFromColumns({ session_id: "", revision: 0 }), SQLiteStorageCorruptionError);
});

test("operationRecordFromColumns maps nullable completion fields and rejects bad enums/JSON", () => {
  const good = {
    operation_id: "op-1",
    session_id: "s1",
    idempotency_key: "k",
    request_hash: HASH,
    expected_revision: 0,
    status: "completed",
    lease_expires_at_ms: null,
    fencing_token: 1,
    completion_kind: "turn",
    turn_id: "t1",
    public_response_json: JSON.stringify({ ok: true })
  };
  const mapped = operationRecordFromColumns(good);
  assert.equal(mapped.leaseExpiresAtMs, null);
  assert.deepEqual(mapped.publicResponse, { ok: true });
  assert.equal(Object.isFrozen(mapped), true);

  assert.throws(() => operationRecordFromColumns({ ...good, status: "bogus" }), SQLiteStorageCorruptionError);
  assert.throws(() => operationRecordFromColumns({ ...good, completion_kind: "bogus" }), SQLiteStorageCorruptionError);
  assert.throws(
    () => operationRecordFromColumns({ ...good, public_response_json: "]" }),
    (error) => error instanceof SQLiteStorageCorruptionError && /public response is invalid JSON/.test(error.message)
  );
  // Mapping is intentionally not a validator for numeric columns: negative values pass through unchanged.
  assert.equal(operationRecordFromColumns({ ...good, expected_revision: -1 }).expectedRevision, -1);
});

test("turnEvidenceFromColumns validates ordering and lower-cases the state hash", () => {
  const evidence = turnEvidenceFromColumns({ turn_id: "t1", before_revision: 0, after_revision: 1, state_hash: HASH.toUpperCase() });
  assert.deepEqual(evidence, { turnId: "t1", beforeRevision: 0, afterRevision: 1, stateHash: HASH });

  assert.throws(() => turnEvidenceFromColumns({ turn_id: null, before_revision: 0, after_revision: 1, state_hash: HASH }), SQLiteStorageCorruptionError);
  assert.throws(() => turnEvidenceFromColumns({ turn_id: "t1", before_revision: 0, after_revision: 3, state_hash: HASH }), SQLiteStorageCorruptionError);
  assert.throws(() => turnEvidenceFromColumns({ turn_id: "t1", before_revision: -1, after_revision: 0, state_hash: "nope" }), SQLiteStorageCorruptionError);
});

test("the bounded limits are the long-standing runtime values", () => {
  assert.equal(MAX_LEASE_DURATION_MS, 300_000);
  assert.equal(MAX_PUBLIC_RESPONSE_JSON_CHARS, 100_000);
});
