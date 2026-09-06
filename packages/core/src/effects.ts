import {
  CONTRACT_SCHEMA_VERSION,
  hasValidWorldStateReferences,
  isGameplayEffect,
  type GameplayEffect,
  type WorldState
} from "@living-history/contracts";

export type EffectBatchFailureCode =
  | "invalid_state"
  | "invalid_effect"
  | "unsupported_effect"
  | "invalid_delta"
  | "resource_not_found"
  | "resource_out_of_bounds";

export interface EffectBatchSuccess {
  readonly ok: true;
  readonly state: WorldState;
  readonly appliedEffects: readonly GameplayEffect[];
}

export interface EffectBatchFailure {
  readonly ok: false;
  readonly code: EffectBatchFailureCode;
  readonly effectIndex: number;
  readonly effectType: string | null;
  readonly sourceId: string | null;
}

export type EffectBatchResult = EffectBatchSuccess | EffectBatchFailure;

/**
 * Apply an already-calculated effect batch to a trial copy of WorldState.
 * Nothing is committed here: a caller receives either one complete next state
 * or a failure with no state at all. Revision/clock changes belong to later
 * action/scheduler layers.
 */
export function tryApplyEffectBatch(
  state: WorldState,
  effects: readonly unknown[]
): EffectBatchResult {
  if (state.schemaVersion !== CONTRACT_SCHEMA_VERSION || !hasValidWorldStateReferences(state)) {
    return failure("invalid_state", -1, null);
  }

  const resources = state.resources.map((resource) => ({ ...resource }));
  const appliedEffects: GameplayEffect[] = [];

  for (let index = 0; index < effects.length; index += 1) {
    const raw = effects[index];
    if (!isGameplayEffect(raw)) {
      const record = asRecord(raw);
      const code = record?.type !== undefined && record.type !== "resource.change"
        ? "unsupported_effect"
        : "invalid_effect";
      return failure(code, index, raw);
    }

    const effect = raw;
    if (!Number.isSafeInteger(effect.delta)) {
      return failure("invalid_delta", index, effect);
    }

    const resourceIndex = resources.findIndex((resource) => resource.id === effect.resourceId);
    if (resourceIndex < 0) {
      return failure("resource_not_found", index, effect);
    }

    const resource = resources[resourceIndex];
    if (!resource
      || !Number.isSafeInteger(resource.value)
      || !Number.isSafeInteger(resource.min)
      || !Number.isSafeInteger(resource.max)
      || resource.min > resource.max
      || resource.value < resource.min
      || resource.value > resource.max) {
      return failure("invalid_state", index, effect);
    }

    const nextValue = resource.value + effect.delta;
    if (!Number.isSafeInteger(nextValue)
      || nextValue < resource.min
      || nextValue > resource.max) {
      return failure("resource_out_of_bounds", index, effect);
    }

    resources[resourceIndex] = Object.freeze({ ...resource, value: nextValue });
    appliedEffects.push(Object.freeze({ ...effect }));
  }

  const nextState = Object.freeze({
    ...state,
    resources: Object.freeze(resources)
  });

  return Object.freeze({
    ok: true,
    state: nextState,
    appliedEffects: Object.freeze(appliedEffects)
  });
}

function failure(code: EffectBatchFailureCode, effectIndex: number, raw: unknown): EffectBatchFailure {
  const record = asRecord(raw);
  return Object.freeze({
    ok: false,
    code,
    effectIndex,
    effectType: typeof record?.type === "string" ? record.type : null,
    sourceId: typeof record?.sourceId === "string" ? record.sourceId : null
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
