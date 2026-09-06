import {
  CONTRACT_SCHEMA_VERSION,
  hasValidWorldStateReferences,
  isSocialAct,
  type CalculatedAction,
  type SocialActionSubject,
  type SocialPermission,
  type SocialRequest,
  type SocialResponse,
  type WorldState
} from "@living-history/contracts";

export type SocialResolutionFailureCode =
  | "invalid_state"
  | "invalid_social_act"
  | "entity_not_found"
  | "proposal_mismatch"
  | "responder_mismatch";

export interface SocialResolutionSuccess {
  readonly ok: true;
  readonly action: CalculatedAction;
}

export interface SocialResolutionFailure {
  readonly ok: false;
  readonly code: SocialResolutionFailureCode;
  readonly referenceId: string | null;
}

export type SocialResolutionResult = SocialResolutionSuccess | SocialResolutionFailure;

export function resolveSocialRequest(state: WorldState, raw: unknown): SocialResolutionResult {
  const stateFailure = validateState(state);
  if (stateFailure) return stateFailure;
  if (!isSocialAct(raw) || raw.type !== "request") return failure("invalid_social_act", null);

  const entityFailure = validatePair(state, raw.fromEntityId, raw.toEntityId);
  if (entityFailure) return entityFailure;

  const request = raw as SocialRequest;
  return success(Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    actionType: "core.social.request",
    status: "conditional",
    reasonCode: "AWAITING_RESPONSE",
    proposalId: request.proposalId,
    fromEntityId: request.fromEntityId,
    toEntityId: request.toEntityId,
    subject: freezeSubject(request.subject),
    durationSeconds: 0,
    effects: Object.freeze([])
  }));
}

export function resolveSocialPermission(state: WorldState, raw: unknown): SocialResolutionResult {
  const stateFailure = validateState(state);
  if (stateFailure) return stateFailure;
  if (!isSocialAct(raw) || raw.type !== "permission") return failure("invalid_social_act", null);

  const entityFailure = validatePair(state, raw.fromEntityId, raw.toEntityId);
  if (entityFailure) return entityFailure;

  const permission = raw as SocialPermission;
  return success(Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    actionType: "core.social.permission",
    status: "executed",
    reasonCode: null,
    permissionId: permission.permissionId,
    fromEntityId: permission.fromEntityId,
    toEntityId: permission.toEntityId,
    subject: freezeSubject(permission.subject),
    durationSeconds: 0,
    effects: Object.freeze([])
  }));
}

/**
 * Resolve an explicit response against one concrete, already-known request.
 * Acceptance records only the responder's decision; it never executes the
 * proposed physical action or creates gameplay effects in this bounded slice.
 */
export function resolveSocialResponse(
  state: WorldState,
  knownRequestRaw: unknown,
  responseRaw: unknown
): SocialResolutionResult {
  const stateFailure = validateState(state);
  if (stateFailure) return stateFailure;
  if (!isSocialAct(knownRequestRaw) || knownRequestRaw.type !== "request") {
    return failure("invalid_social_act", null);
  }
  if (!isSocialAct(responseRaw) || responseRaw.type !== "response") {
    return failure("invalid_social_act", null);
  }

  const request = knownRequestRaw as SocialRequest;
  const response = responseRaw as SocialResponse;
  const entityFailure = validatePair(state, request.fromEntityId, request.toEntityId);
  if (entityFailure) return entityFailure;
  if (!state.entities.some((entity) => entity.id === response.responderId)) {
    return failure("entity_not_found", response.responderId);
  }
  if (response.proposalId !== request.proposalId) {
    return failure("proposal_mismatch", response.proposalId);
  }
  if (response.responderId !== request.toEntityId) {
    return failure("responder_mismatch", response.responderId);
  }

  return success(Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    actionType: "core.social.response",
    status: "executed",
    reasonCode: null,
    responseId: response.responseId,
    proposalId: response.proposalId,
    responderId: response.responderId,
    decision: response.decision,
    durationSeconds: 0,
    effects: Object.freeze([])
  }));
}

function validateState(state: WorldState): SocialResolutionFailure | null {
  return state.schemaVersion === CONTRACT_SCHEMA_VERSION && hasValidWorldStateReferences(state)
    ? null
    : failure("invalid_state", null);
}

function validatePair(state: WorldState, firstId: string, secondId: string): SocialResolutionFailure | null {
  if (!state.entities.some((entity) => entity.id === firstId)) return failure("entity_not_found", firstId);
  if (!state.entities.some((entity) => entity.id === secondId)) return failure("entity_not_found", secondId);
  return null;
}

function freezeSubject(subject: SocialActionSubject): SocialActionSubject {
  return Object.freeze({
    actionType: subject.actionType,
    targetIds: Object.freeze([...subject.targetIds]),
    args: freezeJsonRecord(subject.args)
  });
}

function freezeJsonRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, any>> {
  const result: Record<string, any> = {};
  for (const [key, entry] of Object.entries(value)) result[key] = freezeJsonValue(entry);
  return Object.freeze(result);
}

function freezeJsonValue(value: unknown): any {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJsonValue));
  if (typeof value === "object" && value !== null) return freezeJsonRecord(value as Record<string, unknown>);
  return value;
}

function success(action: CalculatedAction): SocialResolutionSuccess {
  return Object.freeze({ ok: true, action });
}

function failure(code: SocialResolutionFailureCode, referenceId: string | null): SocialResolutionFailure {
  return Object.freeze({ ok: false, code, referenceId });
}
