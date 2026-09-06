import {
  CONTRACT_SCHEMA_VERSION,
  hasValidWorldStateReferences,
  isCondition,
  type Condition,
  type WorldState
} from "@living-history/contracts";

export type ConditionEvaluationFailureCode =
  | "invalid_state"
  | "invalid_condition"
  | "resource_not_found"
  | "entity_not_found"
  | "location_not_found"
  | "item_not_found"
  | "holder_not_found";

export interface ConditionEvaluationSuccess {
  readonly ok: true;
  readonly value: boolean;
}

export interface ConditionEvaluationFailure {
  readonly ok: false;
  readonly code: ConditionEvaluationFailureCode;
  readonly conditionType: string | null;
  readonly referenceId: string | null;
}

export type ConditionEvaluationResult = ConditionEvaluationSuccess | ConditionEvaluationFailure;

/**
 * Evaluate declarative preconditions against authoritative WorldState.
 * A known, well-formed condition may evaluate true or false. Broken references
 * are definition errors and never collapse into false.
 */
export function evaluateCondition(state: WorldState, raw: unknown): ConditionEvaluationResult {
  if (state.schemaVersion !== CONTRACT_SCHEMA_VERSION || !hasValidWorldStateReferences(state)) {
    return failure("invalid_state", null, null);
  }
  if (!isCondition(raw)) {
    return failure("invalid_condition", asType(raw), null);
  }
  return evaluateKnownCondition(state, raw);
}

function evaluateKnownCondition(state: WorldState, condition: Condition): ConditionEvaluationResult {
  switch (condition.type) {
    case "resource.atLeast": {
      const resource = state.resources.find((candidate) => candidate.id === condition.resourceId);
      if (!resource) return failure("resource_not_found", condition.type, condition.resourceId);
      if (!Number.isSafeInteger(resource.value)
        || !Number.isSafeInteger(resource.min)
        || !Number.isSafeInteger(resource.max)
        || resource.min > resource.max
        || resource.value < resource.min
        || resource.value > resource.max) {
        return failure("invalid_state", condition.type, condition.resourceId);
      }
      return success(resource.value >= condition.value);
    }
    case "entity.at": {
      if (!state.locations.some((location) => location.id === condition.locationId)) {
        return failure("location_not_found", condition.type, condition.locationId);
      }
      const entity = state.entities.find((candidate) => candidate.id === condition.entityId);
      if (!entity) return failure("entity_not_found", condition.type, condition.entityId);
      return success(entity.locationId === condition.locationId);
    }
    case "item.heldBy": {
      const item = state.items.find((candidate) => candidate.id === condition.itemId);
      if (!item) return failure("item_not_found", condition.type, condition.itemId);
      if (!state.entities.some((entity) => entity.id === condition.holderId)) {
        return failure("holder_not_found", condition.type, condition.holderId);
      }
      return success(item.position.kind === "holder" && item.position.holderId === condition.holderId);
    }
    case "all": {
      let value = true;
      for (const child of condition.conditions) {
        const result = evaluateKnownCondition(state, child);
        if (!result.ok) return result;
        if (!result.value) value = false;
      }
      return success(value);
    }
    case "any": {
      let value = false;
      for (const child of condition.conditions) {
        const result = evaluateKnownCondition(state, child);
        if (!result.ok) return result;
        if (result.value) value = true;
      }
      return success(value);
    }
    case "not": {
      const result = evaluateKnownCondition(state, condition.condition);
      return result.ok ? success(!result.value) : result;
    }
  }
}

function success(value: boolean): ConditionEvaluationSuccess {
  return Object.freeze({ ok: true, value });
}

function failure(
  code: ConditionEvaluationFailureCode,
  conditionType: string | null,
  referenceId: string | null
): ConditionEvaluationFailure {
  return Object.freeze({ ok: false, code, conditionType, referenceId });
}

function asType(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const type = (value as Record<string, unknown>).type;
  return typeof type === "string" ? type : null;
}
