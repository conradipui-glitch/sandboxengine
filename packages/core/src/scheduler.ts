import {
  CONTRACT_SCHEMA_VERSION,
  isScheduledEvent,
  type ScheduledEvent,
  type WorldState
} from "@living-history/contracts";

export const DEFAULT_MAX_EVENTS_PER_INTERVAL = 100;
export const HARD_MAX_EVENTS_PER_INTERVAL = 1000;

export interface TimeAdvanceOptions {
  readonly maxEvents?: number;
}

export type TimeAdvanceFailureCode =
  | "invalid_state"
  | "invalid_duration"
  | "invalid_options"
  | "invalid_event"
  | "duplicate_event_id"
  | "past_event"
  | "clock_overflow"
  | "event_limit_exceeded";

export interface TimeAdvancePlanSuccess {
  readonly ok: true;
  readonly startElapsedSeconds: number;
  readonly endElapsedSeconds: number;
  readonly dueEvents: readonly ScheduledEvent[];
  readonly pendingEvents: readonly ScheduledEvent[];
}

export interface TimeAdvancePlanFailure {
  readonly ok: false;
  readonly code: TimeAdvanceFailureCode;
  readonly eventId?: string;
  readonly dueEventCount?: number;
  readonly maxEvents?: number;
}

export type TimeAdvancePlanResult = TimeAdvancePlanSuccess | TimeAdvancePlanFailure;

/**
 * Creates a deterministic plan for the inclusive game-time interval [start, end].
 * This function never mutates WorldState, never applies event effects, and never
 * commits elapsed time. Events exactly at start or end are due; events before
 * start are invalid queue state; events after end remain pending.
 */
export function planTimeAdvance(
  state: WorldState,
  durationSeconds: number,
  events: readonly ScheduledEvent[],
  options: TimeAdvanceOptions = {}
): TimeAdvancePlanResult {
  const startElapsedSeconds = state.clock?.elapsedSeconds;
  if (state.schemaVersion !== CONTRACT_SCHEMA_VERSION
    || !isSafeNonNegativeInteger(state.revision)
    || !isSafeNonNegativeInteger(startElapsedSeconds)) {
    return failure("invalid_state");
  }
  if (!isSafeNonNegativeInteger(durationSeconds)) return failure("invalid_duration");

  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS_PER_INTERVAL;
  if (!Number.isSafeInteger(maxEvents)
    || maxEvents < 1
    || maxEvents > HARD_MAX_EVENTS_PER_INTERVAL) {
    return failure("invalid_options");
  }

  const endElapsedSeconds = startElapsedSeconds + durationSeconds;
  if (!Number.isSafeInteger(endElapsedSeconds)) return failure("clock_overflow");

  const seenIds = new Set<string>();
  const copied: ScheduledEvent[] = [];
  for (const event of events) {
    if (!isScheduledEvent(event)) return failure("invalid_event");
    if (seenIds.has(event.eventId)) return failure("duplicate_event_id", event.eventId);
    seenIds.add(event.eventId);
    if (event.atElapsedSeconds < startElapsedSeconds) return failure("past_event", event.eventId);
    copied.push(event);
  }

  copied.sort(compareScheduledEvents);
  const dueEvents = copied.filter((event) => event.atElapsedSeconds <= endElapsedSeconds);
  if (dueEvents.length > maxEvents) {
    return Object.freeze({
      ok: false,
      code: "event_limit_exceeded",
      dueEventCount: dueEvents.length,
      maxEvents
    });
  }
  const pendingEvents = copied.filter((event) => event.atElapsedSeconds > endElapsedSeconds);

  return Object.freeze({
    ok: true,
    startElapsedSeconds,
    endElapsedSeconds,
    dueEvents: Object.freeze([...dueEvents]),
    pendingEvents: Object.freeze([...pendingEvents])
  });
}

export function compareScheduledEvents(left: ScheduledEvent, right: ScheduledEvent): number {
  if (left.atElapsedSeconds !== right.atElapsedSeconds) {
    return left.atElapsedSeconds - right.atElapsedSeconds;
  }
  if (left.order !== right.order) return left.order - right.order;
  if (left.eventId < right.eventId) return -1;
  if (left.eventId > right.eventId) return 1;
  return 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function failure(code: TimeAdvanceFailureCode, eventId?: string): TimeAdvancePlanFailure {
  return eventId === undefined
    ? Object.freeze({ ok: false, code })
    : Object.freeze({ ok: false, code, eventId });
}
