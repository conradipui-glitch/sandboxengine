import type { WorldState } from "@living-history/contracts";
import {
  canonicalRequestHash,
  cloneJson,
  cloneAndFreeze,
  deepFreeze,
  frozen,
  isLeaseEndSafe,
  isPositiveSafeInteger,
  isPublicResponse,
  isRuntimeId,
  isSafeNonNegativeInteger,
  isValidCandidateState,
  isValidClaimInput,
  isValidRenewInput,
  isValidSeedSession,
  isValidTurnRecord
} from "./json-guards.js";
import type { ServiceClock } from "./service-clock.js";
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
  RuntimePublicResponse,
  RuntimeStorage,
  SessionRecord,
  TurnRecordBoundary
} from "./storage.js";

// Bounded policy now lives in json-guards.ts; re-exported here so the package's
// long-standing public names (index.ts imports them from this module) are unchanged.
export { MAX_LEASE_DURATION_MS, MAX_PUBLIC_RESPONSE_JSON_CHARS } from "./json-guards.js";

type OperationIdFactory = (ordinal: number) => string;

export interface MemoryRuntimeStorageOptions {
  readonly clock: ServiceClock;
  readonly sessions: readonly SessionRecord[];
  readonly operationIdFactory?: OperationIdFactory;
}

interface MutableSession {
  readonly sessionId: string;
  readonly release: SessionRecord["release"];
  state: WorldState;
  revision: number;
  activeOperationId: string | null;
  fencingCounter: number;
}

/**
 * In-process reference implementation of the B04 operation state machine.
 * It is intentionally not durable. SQLite must reproduce these outcomes.
 */
export class MemoryRuntimeStorage implements RuntimeStorage {
  readonly #clock: ServiceClock;
  readonly #operationIdFactory: OperationIdFactory;
  readonly #sessions = new Map<string, MutableSession>();
  readonly #operations = new Map<string, OperationRecord>();
  readonly #operationByKey = new Map<string, string>();
  readonly #turns = new Map<string, readonly TurnRecordBoundary[]>();
  #nextOperationOrdinal = 1;

  constructor(options: MemoryRuntimeStorageOptions) {
    this.#clock = options.clock;
    this.#operationIdFactory = options.operationIdFactory ?? ((ordinal) => `op-${ordinal}`);
    this.#serviceNow();

    for (const seed of options.sessions) {
      if (!isValidSeedSession(seed) || this.#sessions.has(seed.sessionId)) {
        throw new TypeError("invalid or duplicate seed session");
      }
      this.#sessions.set(seed.sessionId, {
        sessionId: seed.sessionId,
        release: deepFreeze(cloneJson(seed.release)),
        state: deepFreeze(cloneJson(seed.state)),
        revision: seed.revision,
        activeOperationId: null,
        fencingCounter: 0
      });
      this.#turns.set(seed.sessionId, Object.freeze([]));
    }
  }

  async loadSession(sessionId: string): Promise<SessionRecord | null> {
    if (!isRuntimeId(sessionId)) return null;
    const session = this.#sessions.get(sessionId);
    return session ? snapshotSession(session) : null;
  }

  async getOperation(sessionId: string, operationId: string): Promise<OperationRecord | null> {
    if (!isRuntimeId(sessionId) || !isRuntimeId(operationId)) return null;
    const operation = this.#operations.get(operationId);
    if (!operation || operation.sessionId !== sessionId) return null;
    return snapshotOperation(operation);
  }

  async claimOperation(input: ClaimOperationInput): Promise<ClaimOperationResult> {
    const now = this.#serviceNow();
    if (!isValidClaimInput(input) || !isLeaseEndSafe(now, input.leaseDurationMs)) {
      return frozen({ kind: "invalid_request" });
    }

    const session = this.#sessions.get(input.sessionId);
    if (!session) return frozen({ kind: "session_not_found" });

    const requestHash = canonicalRequestHash(input.requestHash);
    const key = operationKey(input.sessionId, input.idempotencyKey);
    const existingId = this.#operationByKey.get(key);

    if (existingId !== undefined) {
      const existing = this.#operations.get(existingId);
      if (!existing) return frozen({ kind: "invalid_request" });
      if (existing.requestHash !== requestHash || existing.expectedRevision !== input.expectedRevision) {
        return frozen({ kind: "idempotency_key_reused", operationId: existing.operationId });
      }

      if (existing.status !== "processing") {
        if (existing.publicResponse === null) return frozen({ kind: "invalid_request" });
        return frozen({
          kind: "replay",
          operation: snapshotOperation(existing),
          publicResponse: cloneAndFreezePublicResponse(existing.publicResponse)
        });
      }

      if (existing.leaseExpiresAtMs !== null && now < existing.leaseExpiresAtMs) {
        return frozen({ kind: "processing", operation: snapshotOperation(existing) });
      }
      if (session.revision !== input.expectedRevision) {
        return frozen({ kind: "revision_conflict", currentRevision: session.revision });
      }
      if (session.activeOperationId !== null && session.activeOperationId !== existing.operationId) {
        return frozen({ kind: "action_in_progress", operationId: session.activeOperationId });
      }

      const fencingToken = nextFencingToken(session);
      if (fencingToken === null) return frozen({ kind: "invalid_request" });
      const reacquired: OperationRecord = frozen({
        ...existing,
        leaseExpiresAtMs: now + input.leaseDurationMs,
        fencingToken
      });
      session.activeOperationId = existing.operationId;
      session.fencingCounter = fencingToken;
      this.#operations.set(existing.operationId, reacquired);
      return frozen({ kind: "acquired", operation: snapshotOperation(reacquired), reacquired: true });
    }

    if (session.revision !== input.expectedRevision) {
      return frozen({ kind: "revision_conflict", currentRevision: session.revision });
    }
    if (session.activeOperationId !== null) {
      return frozen({ kind: "action_in_progress", operationId: session.activeOperationId });
    }

    const fencingToken = nextFencingToken(session);
    if (fencingToken === null) return frozen({ kind: "invalid_request" });
    const operationId = this.#operationIdFactory(this.#nextOperationOrdinal++);
    if (!isRuntimeId(operationId) || this.#operations.has(operationId)) {
      return frozen({ kind: "invalid_request" });
    }

    const operation: OperationRecord = frozen({
      operationId,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      expectedRevision: input.expectedRevision,
      status: "processing",
      leaseExpiresAtMs: now + input.leaseDurationMs,
      fencingToken,
      completionKind: null,
      turnId: null,
      publicResponse: null
    });

    session.activeOperationId = operationId;
    session.fencingCounter = fencingToken;
    this.#operations.set(operationId, operation);
    this.#operationByKey.set(key, operationId);
    return frozen({ kind: "acquired", operation: snapshotOperation(operation), reacquired: false });
  }

  async renewLease(input: RenewLeaseInput): Promise<RenewLeaseResult> {
    const now = this.#serviceNow();
    if (!isValidRenewInput(input) || !isLeaseEndSafe(now, input.leaseDurationMs)) {
      return frozen({ kind: "invalid_request" });
    }
    const session = this.#sessions.get(input.sessionId);
    if (!session) return frozen({ kind: "session_not_found" });
    const operation = this.#operations.get(input.operationId);
    if (!operation || operation.sessionId !== input.sessionId) return frozen({ kind: "operation_not_found" });
    if (operation.status !== "processing") return frozen({ kind: "operation_not_processing" });
    if (session.activeOperationId !== operation.operationId) return frozen({ kind: "operation_not_active" });
    if (operation.fencingToken !== input.fencingToken) return frozen({ kind: "stale_fencing_token" });
    if (operation.leaseExpiresAtMs === null || now >= operation.leaseExpiresAtMs) return frozen({ kind: "lease_expired" });

    const renewed: OperationRecord = frozen({ ...operation, leaseExpiresAtMs: now + input.leaseDurationMs });
    this.#operations.set(operation.operationId, renewed);
    return frozen({ kind: "renewed", operation: snapshotOperation(renewed) });
  }

  async commitTurn(input: CommitTurnInput): Promise<CommitTurnResult> {
    const now = this.#serviceNow();
    if (!isRuntimeId(input.sessionId) || !isRuntimeId(input.operationId)
      || !isSafeNonNegativeInteger(input.expectedRevision) || !isPositiveSafeInteger(input.fencingToken)) {
      return frozen({ kind: "invalid_request" });
    }

    const session = this.#sessions.get(input.sessionId);
    if (!session) return frozen({ kind: "session_not_found" });
    const operation = this.#operations.get(input.operationId);
    if (!operation || operation.sessionId !== input.sessionId) return frozen({ kind: "operation_not_found" });
    if (operation.status !== "processing") return frozen({ kind: "operation_not_processing" });
    if (session.revision !== input.expectedRevision || operation.expectedRevision !== input.expectedRevision) {
      return frozen({ kind: "revision_conflict", currentRevision: session.revision });
    }
    if (session.activeOperationId !== operation.operationId) return frozen({ kind: "operation_not_active" });
    if (operation.fencingToken !== input.fencingToken) return frozen({ kind: "stale_fencing_token" });
    if (operation.leaseExpiresAtMs === null || now >= operation.leaseExpiresAtMs) return frozen({ kind: "lease_expired" });
    if (!isValidCandidateState(input.candidateState, input.expectedRevision)) return frozen({ kind: "invalid_candidate_state" });
    if (!isValidTurnRecord(input.turnRecord, operation, input.expectedRevision)
      || this.#turnExists(input.sessionId, input.turnRecord.turnId)) return frozen({ kind: "invalid_turn_record" });
    if (!isPublicResponse(input.publicResponse)) return frozen({ kind: "invalid_public_response" });

    const nextState = deepFreeze(cloneJson(input.candidateState));
    const nextResponse = cloneAndFreezePublicResponse(input.publicResponse);
    const nextTurn = deepFreeze(cloneJson(input.turnRecord));
    const nextOperation: OperationRecord = frozen({
      ...operation,
      status: "completed",
      leaseExpiresAtMs: null,
      completionKind: "turn",
      turnId: nextTurn.turnId,
      publicResponse: nextResponse
    });
    const previousTurns = this.#turns.get(input.sessionId) ?? Object.freeze([]);
    const nextTurns = Object.freeze([...previousTurns, nextTurn]);

    session.state = nextState;
    session.revision = nextState.revision;
    session.activeOperationId = null;
    this.#operations.set(operation.operationId, nextOperation);
    this.#turns.set(input.sessionId, nextTurns);

    return frozen({ kind: "committed", session: snapshotSession(session), operation: snapshotOperation(nextOperation) });
  }

  async finishWithoutTurn(input: FinishWithoutTurnInput): Promise<FinishWithoutTurnResult> {
    const now = this.#serviceNow();
    if (!isRuntimeId(input.sessionId) || !isRuntimeId(input.operationId)
      || !isSafeNonNegativeInteger(input.expectedRevision) || !isPositiveSafeInteger(input.fencingToken)) {
      return frozen({ kind: "invalid_request" });
    }

    const session = this.#sessions.get(input.sessionId);
    if (!session) return frozen({ kind: "session_not_found" });
    const operation = this.#operations.get(input.operationId);
    if (!operation || operation.sessionId !== input.sessionId) return frozen({ kind: "operation_not_found" });
    if (operation.status !== "processing") return frozen({ kind: "operation_not_processing" });
    if (session.revision !== input.expectedRevision || operation.expectedRevision !== input.expectedRevision) {
      return frozen({ kind: "revision_conflict", currentRevision: session.revision });
    }
    if (session.activeOperationId !== operation.operationId) return frozen({ kind: "operation_not_active" });
    if (operation.fencingToken !== input.fencingToken) return frozen({ kind: "stale_fencing_token" });
    if (operation.leaseExpiresAtMs === null || now >= operation.leaseExpiresAtMs) return frozen({ kind: "lease_expired" });
    if (!isPublicResponse(input.publicResponse)) return frozen({ kind: "invalid_public_response" });

    const nextResponse = cloneAndFreezePublicResponse(input.publicResponse);
    const nextOperation: OperationRecord = frozen({
      ...operation,
      status: "finished_without_turn",
      leaseExpiresAtMs: null,
      completionKind: "without_turn",
      turnId: null,
      publicResponse: nextResponse
    });
    session.activeOperationId = null;
    this.#operations.set(operation.operationId, nextOperation);
    return frozen({ kind: "finished", session: snapshotSession(session), operation: snapshotOperation(nextOperation) });
  }

  /** Test-only inspection; not part of RuntimeStorage or future public API. */
  inspectTurnsForTest(sessionId: string): readonly TurnRecordBoundary[] {
    const turns = this.#turns.get(sessionId) ?? Object.freeze([]);
    return deepFreeze(cloneJson(turns));
  }

  #turnExists(sessionId: string, turnId: string): boolean {
    return (this.#turns.get(sessionId) ?? []).some((turn) => turn.turnId === turnId);
  }

  #serviceNow(): number {
    const now = this.#clock.nowMs();
    if (!isSafeNonNegativeInteger(now)) throw new RangeError("ServiceClock returned invalid time");
    return now;
  }
}

function snapshotSession(session: MutableSession): SessionRecord {
  return deepFreeze({
    sessionId: session.sessionId,
    release: cloneJson(session.release),
    state: cloneJson(session.state),
    revision: session.revision,
    activeOperationId: session.activeOperationId
  });
}

function snapshotOperation(operation: OperationRecord): OperationRecord {
  return deepFreeze(cloneJson(operation));
}

function cloneAndFreezePublicResponse(response: RuntimePublicResponse): RuntimePublicResponse {
  return cloneAndFreeze(response);
}

/**
 * DIVERGENT from `sqlite-storage.ts#nextFencingToken(current: number)`: the SQLite
 * copy additionally re-validates its counter because it reads it back from a row,
 * while this one trusts an internal in-memory invariant. Kept separate on purpose.
 */
function nextFencingToken(session: MutableSession): number | null {
  if (session.fencingCounter === Number.MAX_SAFE_INTEGER) return null;
  return session.fencingCounter + 1;
}

function operationKey(sessionId: string, idempotencyKey: string): string {
  return `${sessionId}\u0000${idempotencyKey}`;
}
