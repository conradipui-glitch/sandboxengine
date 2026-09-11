import { CONTRACT_SCHEMA_VERSION, type ContractSchemaVersion } from "./schema.js";
import { isRecord } from "./result.js";
import { hasOnlyKeys, isBoundedId, isSafeNonNegativeInteger } from "./primitives.js";

export const SCHEDULED_TERMINAL_EVENT_KIND = "core.terminal" as const;

export interface ScheduledTerminalEventPayload {
  readonly reason: string;
  readonly outcome: string;
}

export interface ScheduledTerminalEvent {
  readonly schemaVersion: ContractSchemaVersion;
  readonly eventId: string;
  readonly atElapsedSeconds: number;
  readonly order: number;
  readonly sourceId: string;
  readonly kind: typeof SCHEDULED_TERMINAL_EVENT_KIND;
  readonly payload: ScheduledTerminalEventPayload;
}

export function isScheduledTerminalEvent(value: unknown): value is ScheduledTerminalEvent {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "schemaVersion",
    "eventId",
    "atElapsedSeconds",
    "order",
    "sourceId",
    "kind",
    "payload"
  ])) return false;

  return value.schemaVersion === CONTRACT_SCHEMA_VERSION
    && isBoundedId(value.eventId, 200)
    && isSafeNonNegativeInteger(value.atElapsedSeconds)
    && isSafeNonNegativeInteger(value.order)
    && isBoundedId(value.sourceId, 200)
    && value.kind === SCHEDULED_TERMINAL_EVENT_KIND
    && isTerminalPayload(value.payload);
}

function isTerminalPayload(value: unknown): value is ScheduledTerminalEventPayload {
  return isRecord(value)
    && hasOnlyKeys(value, ["reason", "outcome"])
    && isBoundedId(value.reason, 200)
    && isBoundedId(value.outcome, 500);
}
