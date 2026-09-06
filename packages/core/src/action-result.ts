import {
  isActionResultEnvelope,
  type ActionResultEnvelope
} from "@living-history/contracts";

/**
 * Runtime guard for the first public Core boundary.
 * It validates shape only; applying effects belongs to a later transaction block.
 */
export function isCanonicalActionResult(value: unknown): value is ActionResultEnvelope {
  return isActionResultEnvelope(value);
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
