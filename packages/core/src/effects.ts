import {
  CONTRACT_SCHEMA_VERSION,
  GAMEPLAY_EFFECT_TYPES,
  hasValidWorldStateReferences,
  isGameplayEffect,
  type GameplayEffect,
  type GameplayEffectType,
  type WorldItem,
  type WorldState
} from "@living-history/contracts";

export type EffectBatchFailureCode =
  | "invalid_state"
  | "invalid_effect"
  | "unsupported_effect"
  | "invalid_delta"
  | "resource_not_found"
  | "resource_out_of_bounds"
  | "item_not_found"
  | "holder_not_found"
  | "location_not_found";

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
  const items = state.items.map((item) => ({ ...item, position: { ...item.position } })) as WorldItem[];
  const appliedEffects: GameplayEffect[] = [];

  for (let index = 0; index < effects.length; index += 1) {
    const raw = effects[index];
    if (!isGameplayEffect(raw)) {
      const record = asRecord(raw);
      const type = typeof record?.type === "string" ? record.type : null;
      const code = type !== null && !GAMEPLAY_EFFECT_TYPES.includes(type as GameplayEffectType)
        ? "unsupported_effect"
        : "invalid_effect";
      return failure(code, index, raw);
    }

    const effect = raw;
    if (effect.type === "resource.change") {
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
    } else {
      const itemIndex = items.findIndex((item) => item.id === effect.itemId);
      if (itemIndex < 0) return failure("item_not_found", index, effect);

      const destination = effect.destination;
      if (destination.kind === "holder") {
        if (!state.entities.some((entity) => entity.id === destination.holderId)) {
          return failure("holder_not_found", index, effect);
        }
      } else if (!state.locations.some((location) => location.id === destination.locationId)) {
        return failure("location_not_found", index, effect);
      }

      const item = items[itemIndex];
      if (!item) return failure("invalid_state", index, effect);
      items[itemIndex] = Object.freeze({
        ...item,
        position: Object.freeze({ ...destination })
      });
    }

    appliedEffects.push(Object.freeze({
      ...effect,
      ...(effect.type === "item.transfer"
        ? { destination: Object.freeze({ ...effect.destination }) }
        : {})
    }) as GameplayEffect);
  }

  const nextState = Object.freeze({
    ...state,
    resources: Object.freeze(resources),
    items: Object.freeze(items)
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
