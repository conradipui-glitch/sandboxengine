import { isGameplayEffect, type GameplayEffect } from "./gameplay-effect.js";
import { CONTRACT_SCHEMA_VERSION, type ContractSchemaVersion } from "./schema.js";
import { isRecord } from "./result.js";
import { isScheduledEvent, type ScheduledEvent } from "./scheduled-event.js";
import {
  isScheduledTerminalEvent,
  type ScheduledTerminalEvent
} from "./scheduled-terminal-event.js";

export const SCHEDULED_EFFECT_EVENT_KIND = "core.effects" as const;
export const MAX_EFFECTS_PER_SCHEDULED_EVENT = 100;

export interface ScheduledEffectEventPayload {
  readonly effects: readonly GameplayEffect[];
}

export interface ScheduledEffectEvent {
  readonly schemaVersion: ContractSchemaVersion;
  readonly eventId: string;
  readonly atElapsedSeconds: number;
  readonly order: number;
  readonly sourceId: string;
  readonly kind: typeof SCHEDULED_EFFECT_EVENT_KIND;
  readonly payload: ScheduledEffectEventPayload;
}

export type SchedulerEvent = ScheduledEvent | ScheduledEffectEvent | ScheduledTerminalEvent;

export function isScheduledEffectEvent(value: unknown): value is ScheduledEffectEvent {
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
    && value.kind === SCHEDULED_EFFECT_EVENT_KIND
    && isEffectPayload(value.payload);
}

export function isSchedulerEvent(value: unknown): value is SchedulerEvent {
  return isScheduledEvent(value)
    || isScheduledEffectEvent(value)
    || isScheduledTerminalEvent(value);
}

function isEffectPayload(value: unknown): value is ScheduledEffectEventPayload {
  return isRecord(value)
    && hasOnlyKeys(value, ["effects"])
    && Array.isArray(value.effects)
    && value.effects.length >= 1
    && value.effects.length <= MAX_EFFECTS_PER_SCHEDULED_EVENT
    && value.effects.every(isGameplayEffect);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}
