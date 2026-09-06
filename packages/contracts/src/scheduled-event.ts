import { CONTRACT_SCHEMA_VERSION, type ContractSchemaVersion } from "./schema.js";
import { isRecord } from "./result.js";

export const SCHEDULED_EVENT_KINDS = ["core.marker"] as const;
export type ScheduledEventKind = (typeof SCHEDULED_EVENT_KINDS)[number];

export interface MarkerEventPayload {
  readonly markerId: string;
}

export interface ScheduledEvent {
  readonly schemaVersion: ContractSchemaVersion;
  readonly eventId: string;
  readonly atElapsedSeconds: number;
  readonly order: number;
  readonly sourceId: string;
  readonly kind: "core.marker";
  readonly payload: MarkerEventPayload;
}

export function isScheduledEvent(value: unknown): value is ScheduledEvent {
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
    && isBoundedId(value.eventId)
    && isSafeNonNegativeInteger(value.atElapsedSeconds)
    && isSafeNonNegativeInteger(value.order)
    && isBoundedId(value.sourceId)
    && value.kind === "core.marker"
    && isMarkerPayload(value.payload);
}

function isMarkerPayload(value: unknown): value is MarkerEventPayload {
  return isRecord(value)
    && hasOnlyKeys(value, ["markerId"])
    && isBoundedId(value.markerId);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}
