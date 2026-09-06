import { CONTRACT_SCHEMA_VERSION, type ContractSchemaVersion } from "./schema.js";
import { isGameplayEffect, type GameplayEffect } from "./gameplay-effect.js";
import { isRecord } from "./result.js";

export const CALCULATED_ACTION_TYPES = ["core.paint"] as const;
export type CalculatedActionType = (typeof CALCULATED_ACTION_TYPES)[number];
export type CalculatedActionStatus = "executed" | "partial" | "blocked";

export interface PaintCalculatedAction {
  readonly schemaVersion: ContractSchemaVersion;
  readonly actionType: "core.paint";
  readonly status: CalculatedActionStatus;
  readonly reasonCode: string | null;
  readonly requestedUnits: number;
  readonly completedUnits: number;
  readonly durationSeconds: number;
  readonly effects: readonly GameplayEffect[];
}

/**
 * Strict calculated gameplay outcome. This is intentionally separate from the
 * B01 transport ActionResult v1.0 until a public compatibility migration is
 * designed; Core may already depend on this contract internally.
 */
export type CalculatedAction = PaintCalculatedAction;

export function isCalculatedAction(value: unknown): value is CalculatedAction {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, [
    "schemaVersion",
    "actionType",
    "status",
    "reasonCode",
    "requestedUnits",
    "completedUnits",
    "durationSeconds",
    "effects"
  ])) return false;

  return value.schemaVersion === CONTRACT_SCHEMA_VERSION
    && value.actionType === "core.paint"
    && (value.status === "executed" || value.status === "partial" || value.status === "blocked")
    && (value.reasonCode === null || (typeof value.reasonCode === "string" && value.reasonCode.length > 0 && value.reasonCode.length <= 100))
    && typeof value.requestedUnits === "number"
    && Number.isInteger(value.requestedUnits)
    && value.requestedUnits >= 1
    && typeof value.completedUnits === "number"
    && Number.isInteger(value.completedUnits)
    && value.completedUnits >= 0
    && typeof value.durationSeconds === "number"
    && Number.isInteger(value.durationSeconds)
    && value.durationSeconds >= 0
    && Array.isArray(value.effects)
    && value.effects.every(isGameplayEffect);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}
