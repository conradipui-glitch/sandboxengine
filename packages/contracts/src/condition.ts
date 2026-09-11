import { CONTRACT_SCHEMA_VERSION, type ContractSchemaVersion } from "./schema.js";
import { isRecord } from "./result.js";
import { hasOnlyKeys, isId } from "./primitives.js";

export const CONDITION_TYPES = [
  "resource.atLeast",
  "entity.at",
  "item.heldBy",
  "all",
  "any",
  "not"
] as const;

export type ConditionType = (typeof CONDITION_TYPES)[number];

interface ConditionBase<T extends ConditionType> {
  readonly schemaVersion: ContractSchemaVersion;
  readonly type: T;
}

export interface ResourceAtLeastCondition extends ConditionBase<"resource.atLeast"> {
  readonly resourceId: string;
  readonly value: number;
}

export interface EntityAtCondition extends ConditionBase<"entity.at"> {
  readonly entityId: string;
  readonly locationId: string;
}

export interface ItemHeldByCondition extends ConditionBase<"item.heldBy"> {
  readonly itemId: string;
  readonly holderId: string;
}

export interface AllCondition extends ConditionBase<"all"> {
  readonly conditions: readonly Condition[];
}

export interface AnyCondition extends ConditionBase<"any"> {
  readonly conditions: readonly Condition[];
}

export interface NotCondition extends ConditionBase<"not"> {
  readonly condition: Condition;
}

export type Condition =
  | ResourceAtLeastCondition
  | EntityAtCondition
  | ItemHeldByCondition
  | AllCondition
  | AnyCondition
  | NotCondition;

export function isCondition(value: unknown): value is Condition {
  return isConditionAtDepth(value, 0);
}

function isConditionAtDepth(value: unknown, depth: number): value is Condition {
  if (depth > 32 || !isRecord(value) || value.schemaVersion !== CONTRACT_SCHEMA_VERSION) return false;
  switch (value.type) {
    case "resource.atLeast":
      return hasOnlyKeys(value, ["schemaVersion", "type", "resourceId", "value"])
        && isId(value.resourceId)
        && typeof value.value === "number"
        && Number.isSafeInteger(value.value);
    case "entity.at":
      return hasOnlyKeys(value, ["schemaVersion", "type", "entityId", "locationId"])
        && isId(value.entityId)
        && isId(value.locationId);
    case "item.heldBy":
      return hasOnlyKeys(value, ["schemaVersion", "type", "itemId", "holderId"])
        && isId(value.itemId)
        && isId(value.holderId);
    case "all":
    case "any":
      return hasOnlyKeys(value, ["schemaVersion", "type", "conditions"])
        && Array.isArray(value.conditions)
        && value.conditions.length >= 1
        && value.conditions.length <= 64
        && value.conditions.every((condition) => isConditionAtDepth(condition, depth + 1));
    case "not":
      return hasOnlyKeys(value, ["schemaVersion", "type", "condition"])
        && isConditionAtDepth(value.condition, depth + 1);
    default:
      return false;
  }
}
