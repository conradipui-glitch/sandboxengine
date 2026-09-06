import { isGameplayEffect, type GameplayEffect } from "./gameplay-effect.js";
import { isRecord } from "./result.js";
import { CONTRACT_SCHEMA_VERSION, type ContractSchemaVersion } from "./schema.js";

export const SCHEDULED_TASK_KIND = "core.task" as const;
export const MAX_EFFECTS_PER_TASK_PHASE = 100;

export interface ScheduledTask {
  readonly schemaVersion: ContractSchemaVersion;
  readonly kind: typeof SCHEDULED_TASK_KIND;
  readonly taskId: string;
  readonly sourceId: string;
  readonly actorEntityId: string;
  readonly startAtElapsedSeconds: number;
  readonly completeAtElapsedSeconds: number;
  readonly baseOrder: number;
  readonly startEffects: readonly GameplayEffect[];
  readonly completionEffects: readonly GameplayEffect[];
}

export function isScheduledTask(value: unknown): value is ScheduledTask {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "schemaVersion",
    "kind",
    "taskId",
    "sourceId",
    "actorEntityId",
    "startAtElapsedSeconds",
    "completeAtElapsedSeconds",
    "baseOrder",
    "startEffects",
    "completionEffects"
  ])) return false;

  return value.schemaVersion === CONTRACT_SCHEMA_VERSION
    && value.kind === SCHEDULED_TASK_KIND
    && isBoundedId(value.taskId, 180)
    && isBoundedId(value.sourceId, 200)
    && isBoundedId(value.actorEntityId, 200)
    && isSafeNonNegativeInteger(value.startAtElapsedSeconds)
    && isSafeNonNegativeInteger(value.completeAtElapsedSeconds)
    && value.completeAtElapsedSeconds >= value.startAtElapsedSeconds
    && isSafeNonNegativeInteger(value.baseOrder)
    && value.baseOrder < Number.MAX_SAFE_INTEGER
    && isEffectList(value.startEffects)
    && isEffectList(value.completionEffects);
}

function isEffectList(value: unknown): value is readonly GameplayEffect[] {
  return Array.isArray(value)
    && value.length <= MAX_EFFECTS_PER_TASK_PHASE
    && value.every(isGameplayEffect);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedId(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}
