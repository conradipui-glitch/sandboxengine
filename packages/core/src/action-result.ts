import {
  isActionStatus,
  isEffectRef,
  isRecord,
  type ActionResultEnvelope
} from "@living-history/contracts";

/**
 * Runtime guard for the first public Core boundary.
 * It validates shape only; applying effects belongs to a later transaction block.
 */
export function isCanonicalActionResult(value: unknown): value is ActionResultEnvelope {
  if (!isRecord(value)) return false;
  if (!isActionStatus(value.status)) return false;
  if (typeof value.durationSeconds !== "number"
    || !Number.isInteger(value.durationSeconds)
    || value.durationSeconds < 0) return false;
  return Array.isArray(value.effects) && value.effects.every(isEffectRef);
}

export function executedResult(
  durationSeconds: number,
  effects: readonly ActionResultEnvelope["effects"][number][] = []
): ActionResultEnvelope {
  if (!Number.isInteger(durationSeconds) || durationSeconds < 0) {
    throw new RangeError("durationSeconds must be a non-negative integer");
  }
  return { status: "executed", durationSeconds, effects: [...effects] };
}

