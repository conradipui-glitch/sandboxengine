import { CONTRACT_SCHEMA_VERSION, type ContractSchemaVersion } from "./schema.js";
import { isRecord } from "./result.js";
import { hasOnlyKeys, isBoundedId, isSafeNonNegativeInteger } from "./primitives.js";

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
    && isBoundedId(value.eventId, 200)
    && isSafeNonNegativeInteger(value.atElapsedSeconds)
    && isSafeNonNegativeInteger(value.order)
    && isBoundedId(value.sourceId, 200)
    && value.kind === "core.marker"
    && isMarkerPayload(value.payload);
}

function isMarkerPayload(value: unknown): value is MarkerEventPayload {
  return isRecord(value)
    && hasOnlyKeys(value, ["markerId"])
    && isBoundedId(value.markerId, 200);
}
