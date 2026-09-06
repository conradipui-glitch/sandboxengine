import {
  CONTRACT_SCHEMA_VERSION,
  hasValidWorldStateReferences,
  type JsonValue,
  type WorldState
} from "@living-history/contracts";
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

export const MAX_LEASE_DURATION_MS = 300_000;
export const MAX_PUBLIC_RESPONSE_JSON_CHARS = 100_000;

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

    const serviceNow = this.#clock.nowMs();
    if (!isSafeNonNegativeInteger(serviceNow)) throw new RangeError("ServiceClock returned invalid time");

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

    const key = operationKey(input.sessionId, input.idempotencyKey);
    const existingId = this.#operationByKey.get(key);
    if (existingId !== undefined) {
      const existing = this.#operations.get(existingId);
      if (!existing) return frozen({ kind: "invalid_request" });

      if (existing.requestHash !== input.requestHash || existing.expectedRevision !== input.expectedRevision) {
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

      const token = nextFencingToken(session);
      if (token === null) return frozen({ kind: "invalid_request" });
      const reacquired: OperationRecord = frozen({
        ...existing,
        leaseExpiresAtMs: now + input.leaseDurationMs,
        fencingToken: token
      });
      session.activeOperationId = existing.operationId;
      session.fencingCounter = token;
      this.#operations.set(existing.operationId, reacquired);
      return frozen({ kind: "acquired", operation: snapshotOperation(reacquired), reacquired: true });
    }

    if (session.revision !== input.expectedRevision) {
      return frozen({ kind: "revision_conflict", currentRevision: session.revision });
    }
    if (session.activeOperationId !== null) {
      return frozen({ kind: "action_in_progress", operationId: session.activeOperationId });
    }

    const token = nextFencingToken(session);
    if (token === null) return frozen({ kind: "invalid_request" });
    const operationId = this.#operationIdFactory(this.#nextOperationOrdinal++);
    if (!isRuntimeId(operationId) || this.#operations.has(operationId)) {
      return frozen({ kind: "invalid_request" });
    }

    const operation: OperationRecord = frozen({
      operationId,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash.toLowerCase(),
      expectedRevision: input.expectedRevision,
      status: "processing",
      leaseExpiresAtMs: now + input.leaseDurationMs,
      fencingToken: token,
      completionKind: null,
      turnId: null,
      publicResponse: null
    });

    session.activeOperationId = operationId;
    session.fencingCounter = token;
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
    if (operation.leaseExpiresAtMs === null || now >= operation.leaseExpiresAtMs) {
      return frozen({ kind: "lease_expired" });
    }

    const renewed: OperationRecord = frozen({
      ...operation,
      leaseExpiresAtMs: now + input.leaseDurationMs
    });
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
    if (operation.leaseExpiresAtMs === null || now >= operation.leaseExpiresAtMs) {
      return frozen({ kind: "lease_expired" });
    }
    if (!isValidCandidateState(input.candidateState, input.expectedRevision)) {
      return frozen({ kind: "invalid_candidate_state" });
    }
    if (!isValidTurnRecord(input.turnRecord, operation, input.expectedRevision)
      || this.#turnExists(input.sessionId, input.turnRecord.turnId)) {
      return frozen({ kind: "invalid_turn_record" });
    }
    if (!isPublicResponse(input.publicResponse)) return frozen({ kind: "invalid_public_response" });

    // Prepare every replacement before mutating the authoritative maps.
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

    return frozen({
      kind: "committed",
      session: snapshotSession(session),
      operation: snapshotOperation(nextOperation)
    });
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
    if (operation.leaseExpiresAtMs === null || now >= operation.leaseExpiresAtMs) {
      return frozen({ kind: "lease_expired" });
    }
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

    return frozen({
      kind: "finished",
      session: snapshotSession(session),
      operation: snapshotOperation(nextOperation)
    });
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
  return deepFreeze(cloneJson(response));
}

function isValidSeedSession(session: SessionRecord): boolean {
  return isRuntimeId(session.sessionId)
    && session.activeOperationId === null
    && isRuntimeId(session.release.questId)
    && isRuntimeId(session.release.releaseId)
    && isSha256(session.release.contentHash)
    && isSafeNonNegativeInteger(session.revision)
    && session.state.revision === session.revision
    && isValidWorldState(session.state);
}

function isValidClaimInput(input: ClaimOperationInput): boolean {
  return isRuntimeId(input.sessionId)
    && isIdempotencyKey(input.idempotencyKey)
    && isSha256(input.requestHash)
    && isSafeNonNegativeInteger(input.expectedRevision)
    && isValidLeaseDuration(input.leaseDurationMs);
}

function isValidRenewInput(input: RenewLeaseInput): boolean {
  return isRuntimeId(input.sessionId)
    && isRuntimeId(input.operationId)
    && isPositiveSafeInteger(input.fencingToken)
    && isValidLeaseDuration(input.leaseDurationMs);
}

function isValidLeaseDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_LEASE_DURATION_MS;
}

function isLeaseEndSafe(now: number, duration: number): boolean {
  return Number.isSafeInteger(now + duration);
}

function isValidCandidateState(state: WorldState, expectedRevision: number): boolean {
  if (expectedRevision === Number.MAX_SAFE_INTEGER) return false;
  return isValidWorldState(state) && state.revision === expectedRevision + 1;
}

function isValidWorldState(state: WorldState): boolean {
  if (state.schemaVersion !== CONTRACT_SCHEMA_VERSION
    || !isSafeNonNegativeInteger(state.revision)
    || !isSafeNonNegativeInteger(state.clock?.elapsedSeconds)
    || !Array.isArray(state.locations)
    || !Array.isArray(state.entities)
    || !Array.isArray(state.resources)
    || !Array.isArray(state.items)) return false;
  if (!hasValidWorldStateReferences(state)) return false;
  for (const resource of state.resources) {
    if (!Number.isSafeInteger(resource.value) || !Number.isSafeInteger(resource.min) || !Number.isSafeInteger(resource.max)) return false;
    if (resource.min > resource.max || resource.value < resource.min || resource.value > resource.max) return false;
  }
  return true;
}

function isValidTurnRecord(record: TurnRecordBoundary, operation: OperationRecord, expectedRevision: number): boolean {
  return isRuntimeId(record.turnId)
    && record.operationId === operation.operationId
    && record.sessionId === operation.sessionId
    && record.beforeRevision === expectedRevision
    && record.afterRevision === expectedRevision + 1
    && isSha256(record.stateHash);
}

function isPublicResponse(value: RuntimePublicResponse): boolean {
  if (!isPlainObject(value) || !isJsonValue(value, 0)) return false;
  try {
    return JSON.stringify(value).length <= MAX_PUBLIC_RESPONSE_JSON_CHARS;
  } catch {
    return false;
  }
}

function isJsonValue(value: unknown, depth: number): value is JsonValue {
  if (depth > 20) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1_000 && value.every((entry) => isJsonValue(entry, depth + 1));
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 1_000 && entries.every(([key, entry]) => key.length <= 200 && isJsonValue(entry, depth + 1));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRuntimeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function isIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-fA-F0-9]{64}$/.test(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function nextFencingToken(session: MutableSession): number | null {
  if (session.fencingCounter === Number.MAX_SAFE_INTEGER) return null;
  return session.fencingCounter + 1;
}

function operationKey(sessionId: string, idempotencyKey: string): string {
  return `${sessionId}\u0000${idempotencyKey}`;
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
