import { CONTRACT_SCHEMA_VERSION, type ContractSchemaVersion } from "./schema.js";
import { isRecord } from "./result.js";

export const GAMEPLAY_EFFECT_TYPES = ["resource.change"] as const;
export type GameplayEffectType = (typeof GAMEPLAY_EFFECT_TYPES)[number];

export interface ResourceChangeEffect {
  readonly schemaVersion: ContractSchemaVersion;
  readonly type: "resource.change";
  readonly sourceId: string;
  readonly resourceId: string;
  readonly delta: number;
}

/**
 * Executable gameplay effects are intentionally separate from the B01 generic
 * Effect envelope. This avoids silently breaking Effect schema v1.0 while B02
 * starts a strict discriminated union that can grow through explicit versions.
 */
export type GameplayEffect = ResourceChangeEffect;

export function isGameplayEffect(value: unknown): value is GameplayEffect {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ["schemaVersion", "type", "sourceId", "resourceId", "delta"])) return false;
  return value.schemaVersion === CONTRACT_SCHEMA_VERSION
    && value.type === "resource.change"
    && typeof value.sourceId === "string"
    && value.sourceId.length > 0
    && value.sourceId.length <= 200
    && typeof value.resourceId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.resourceId)
    && typeof value.delta === "number"
    && Number.isInteger(value.delta);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}
