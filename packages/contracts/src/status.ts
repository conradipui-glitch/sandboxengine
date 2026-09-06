/**
 * Outcomes of a calculated game action. Processing states such as
 * `needs_clarification` are intentionally kept in a separate union below.
 */
export const ACTION_STATUSES = [
  "executed",
  "partial",
  "conditional",
  "blocked"
] as const;

export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const PROCESSING_STATUSES = [
  "needs_clarification",
  "unsupported",
  "failed"
] as const;

export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

const actionStatusSet: ReadonlySet<string> = new Set(ACTION_STATUSES);
const processingStatusSet: ReadonlySet<string> = new Set(PROCESSING_STATUSES);

export function isActionStatus(value: unknown): value is ActionStatus {
  return typeof value === "string" && actionStatusSet.has(value);
}

export function isProcessingStatus(value: unknown): value is ProcessingStatus {
  return typeof value === "string" && processingStatusSet.has(value);
}

