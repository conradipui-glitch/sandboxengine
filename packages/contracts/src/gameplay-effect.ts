import { CONTRACT_SCHEMA_VERSION, type ContractSchemaVersion } from "./schema.js";
import { isRecord } from "./result.js";
import type { WorldItemPosition } from "./world-state.js";

export const GAMEPLAY_EFFECT_TYPES = ["entity.move", "item.transfer", "resource.change"] as const;
export type GameplayEffectType = (typeof GAMEPLAY_EFFECT_TYPES)[number];

export interface ResourceChangeEffect {
  readonly schemaVersion: ContractSchemaVersion;
  readonly type: "resource.change";
  readonly sourceId: string;
  readonly resourceId: string;
  readonly delta: number;
}

export interface ItemTransferEffect {
  readonly schemaVersion: ContractSchemaVersion;
  readonly type: "item.transfer";
  readonly sourceId: string;
  readonly itemId: string;
  readonly destination: WorldItemPosition;
}

export interface EntityMoveEffect {
  readonly schemaVersion: ContractSchemaVersion;
  readonly type: "entity.move";
  readonly sourceId: string;
  readonly entityId: string;
  readonly locationId: string;
}

/**
 * Executable gameplay effects are intentionally separate from the B01 generic
 * Effect envelope. Each executable type is added to this strict union only
 * together with deterministic Core semantics and tests.
 */
export type GameplayEffect = ResourceChangeEffect | ItemTransferEffect | EntityMoveEffect;

export function isGameplayEffect(value: unknown): value is GameplayEffect {
  if (!isRecord(value) || value.schemaVersion !== CONTRACT_SCHEMA_VERSION) return false;
  if (value.type === "resource.change") {
    return hasOnlyKeys(value, ["schemaVersion", "type", "sourceId", "resourceId", "delta"])
      && isSourceId(value.sourceId)
      && isId(value.resourceId)
      && typeof value.delta === "number"
      && Number.isInteger(value.delta);
  }
  if (value.type === "item.transfer") {
    return hasOnlyKeys(value, ["schemaVersion", "type", "sourceId", "itemId", "destination"])
      && isSourceId(value.sourceId)
      && isId(value.itemId)
      && isItemPosition(value.destination);
  }
  if (value.type === "entity.move") {
    return hasOnlyKeys(value, ["schemaVersion", "type", "sourceId", "entityId", "locationId"])
      && isSourceId(value.sourceId)
      && isId(value.entityId)
      && isId(value.locationId);
  }
  return false;
}

function isItemPosition(value: unknown): value is WorldItemPosition {
  if (!isRecord(value)) return false;
  if (value.kind === "location") {
    return hasOnlyKeys(value, ["kind", "locationId"]) && isId(value.locationId);
  }
  if (value.kind === "holder") {
    return hasOnlyKeys(value, ["kind", "holderId"]) && isId(value.holderId);
  }
  return false;
}

function isSourceId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function isId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}
