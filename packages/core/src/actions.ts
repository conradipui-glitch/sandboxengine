import {
  CONTRACT_SCHEMA_VERSION,
  isCalculatedAction,
  type CalculatedAction,
  type ResolvedIntent,
  type WorldState
} from "@living-history/contracts";
import { tryApplyEffectBatch, type EffectBatchFailure } from "./effects.js";

export interface PaintActionDefinition {
  readonly id: string;
  readonly actionType: "core.paint";
  readonly resourceId: string;
  readonly resourceUnitsPerUnit: number;
  readonly durationSecondsPerUnit: number;
  readonly allowPartial: boolean;
}

export type ResolvePaintFailureCode =
  | "invalid_definition"
  | "invalid_intent"
  | "invalid_state"
  | "resource_not_found"
  | "calculation_overflow"
  | "effect_application_failed";

export interface ResolvePaintSuccess {
  readonly ok: true;
  readonly action: CalculatedAction;
  readonly state: WorldState;
}

export interface ResolvePaintFailure {
  readonly ok: false;
  readonly code: ResolvePaintFailureCode;
  readonly effectFailure?: EffectBatchFailure;
}

export type ResolvePaintResult = ResolvePaintSuccess | ResolvePaintFailure;

/**
 * First explicit action resolver. It consumes an already-resolved intent, so it
 * performs no natural-language interpretation. The returned duration is only a
 * calculation: this layer never advances WorldState.clock or revision.
 */
export function resolvePaintAction(
  state: WorldState,
  definition: PaintActionDefinition,
  intent: ResolvedIntent
): ResolvePaintResult {
  if (!isValidDefinition(definition)) return failure("invalid_definition");
  const requestedUnits = readRequestedUnits(intent);
  if (requestedUnits === null) return failure("invalid_intent");
  if (state.schemaVersion !== CONTRACT_SCHEMA_VERSION) return failure("invalid_state");

  const resource = state.resources.find((candidate) => candidate.id === definition.resourceId);
  if (!resource) return failure("resource_not_found");
  if (!isSafeResource(resource.value, resource.min, resource.max)) return failure("invalid_state");

  const spendable = resource.value - resource.min;
  if (!Number.isSafeInteger(spendable) || spendable < 0) return failure("invalid_state");
  const possibleUnits = Math.floor(spendable / definition.resourceUnitsPerUnit);
  if (!Number.isSafeInteger(possibleUnits) || possibleUnits < 0) return failure("calculation_overflow");

  if (possibleUnits <= 0 || (!definition.allowPartial && possibleUnits < requestedUnits)) {
    const action = createCalculatedAction({
      status: "blocked",
      requestedUnits,
      completedUnits: 0,
      durationSeconds: 0,
      reasonCode: "RESOURCE_LIMIT",
      effects: []
    });
    return action === null ? failure("calculation_overflow") : Object.freeze({ ok: true, action, state });
  }

  const completedUnits = Math.min(requestedUnits, possibleUnits);
  const spent = completedUnits * definition.resourceUnitsPerUnit;
  const durationSeconds = completedUnits * definition.durationSecondsPerUnit;
  if (!Number.isSafeInteger(spent) || !Number.isSafeInteger(durationSeconds)) {
    return failure("calculation_overflow");
  }

  const effect = Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    type: "resource.change" as const,
    sourceId: definition.id,
    resourceId: definition.resourceId,
    delta: -spent
  });
  const applied = tryApplyEffectBatch(state, [effect]);
  if (!applied.ok) {
    return Object.freeze({ ok: false, code: "effect_application_failed", effectFailure: applied });
  }

  const partial = completedUnits < requestedUnits;
  const action = createCalculatedAction({
    status: partial ? "partial" : "executed",
    requestedUnits,
    completedUnits,
    durationSeconds,
    reasonCode: partial ? "RESOURCE_LIMIT" : null,
    effects: [effect]
  });
  if (action === null) return failure("calculation_overflow");

  return Object.freeze({ ok: true, action, state: applied.state });
}

function createCalculatedAction(input: Omit<CalculatedAction, "schemaVersion" | "actionType">): CalculatedAction | null {
  const action: CalculatedAction = Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    actionType: "core.paint",
    ...input,
    effects: Object.freeze([...input.effects])
  });
  return isCalculatedAction(action) ? action : null;
}

function readRequestedUnits(intent: ResolvedIntent): number | null {
  if (intent.schemaVersion !== CONTRACT_SCHEMA_VERSION || intent.actionType !== "core.paint") return null;
  const keys = Object.keys(intent.args);
  if (keys.length !== 1 || keys[0] !== "units") return null;
  const units = intent.args.units;
  return typeof units === "number" && Number.isSafeInteger(units) && units >= 1 ? units : null;
}

function isValidDefinition(definition: PaintActionDefinition): boolean {
  return definition.actionType === "core.paint"
    && typeof definition.id === "string"
    && definition.id.length > 0
    && typeof definition.resourceId === "string"
    && definition.resourceId.length > 0
    && Number.isSafeInteger(definition.resourceUnitsPerUnit)
    && definition.resourceUnitsPerUnit > 0
    && Number.isSafeInteger(definition.durationSecondsPerUnit)
    && definition.durationSecondsPerUnit >= 0
    && typeof definition.allowPartial === "boolean";
}

function isSafeResource(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value)
    && Number.isSafeInteger(min)
    && Number.isSafeInteger(max)
    && min <= max
    && value >= min
    && value <= max;
}

function failure(code: ResolvePaintFailureCode): ResolvePaintFailure {
  return Object.freeze({ ok: false, code });
}
