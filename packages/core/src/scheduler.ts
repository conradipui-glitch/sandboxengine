import {
  CONTRACT_SCHEMA_VERSION,
  isSchedulerEvent,
  type SchedulerEvent,
  type WorldState
} from "@living-history/contracts";
import { tryApplyEffectBatch, type EffectBatchFailure } from "./effects.js";

export const DEFAULT_MAX_EVENTS_PER_INTERVAL = 100;
export const HARD_MAX_EVENTS_PER_INTERVAL = 1000;

export interface TimeAdvanceOptions {
  readonly maxEvents?: number;
}

export type TimeAdvanceFailureCode =
  | "invalid_state"
  | "already_terminal"
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
  readonly dueEvents: readonly SchedulerEvent[];
  readonly pendingEvents: readonly SchedulerEvent[];
}

export interface TimeAdvancePlanFailure {
  readonly ok: false;
  readonly code: TimeAdvanceFailureCode;
  readonly eventId?: string;
  readonly dueEventCount?: number;
  readonly maxEvents?: number;
}

export type TimeAdvancePlanResult = TimeAdvancePlanSuccess | TimeAdvancePlanFailure;

export type TimeAdvanceApplyFailureCode =
  | "invalid_state"
  | "already_terminal"
  | "invalid_plan"
  | "plan_state_mismatch"
  | "revision_overflow"
  | "event_effect_failed";

export interface TimeAdvanceApplySuccess {
  readonly ok: true;
  readonly state: WorldState;
  readonly appliedEvents: readonly SchedulerEvent[];
  readonly pendingEvents: readonly SchedulerEvent[];
  readonly interrupted: boolean;
  readonly interruptionEventId: string | null;
  readonly unprocessedEvents: readonly SchedulerEvent[];
}

export interface TimeAdvanceApplyFailure {
  readonly ok: false;
  readonly code: TimeAdvanceApplyFailureCode;
  readonly eventIndex?: number;
  readonly eventId?: string;
  readonly effectFailure?: EffectBatchFailure;
}

export type TimeAdvanceApplyResult = TimeAdvanceApplySuccess | TimeAdvanceApplyFailure;

/**
 * Creates a deterministic plan for the inclusive game-time interval [start, end].
 * This function never mutates WorldState, never applies event effects, and never
 * commits elapsed time. Events exactly at start or end are due; events before
 * start are invalid queue state; events after end remain pending.
 */
export function planTimeAdvance(
  state: WorldState,
  durationSeconds: number,
  events: readonly SchedulerEvent[],
  options: TimeAdvanceOptions = {}
): TimeAdvancePlanResult {
  const startElapsedSeconds = state.clock?.elapsedSeconds;
  if (state.schemaVersion !== CONTRACT_SCHEMA_VERSION
    || !isSafeNonNegativeInteger(state.revision)
    || !isSafeNonNegativeInteger(startElapsedSeconds)) {
    return planFailure("invalid_state");
  }
  if (state.terminal !== null) return planFailure("already_terminal");
  if (!isSafeNonNegativeInteger(durationSeconds)) return planFailure("invalid_duration");

  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS_PER_INTERVAL;
  if (!Number.isSafeInteger(maxEvents)
    || maxEvents < 1
    || maxEvents > HARD_MAX_EVENTS_PER_INTERVAL) {
    return planFailure("invalid_options");
  }

  const endElapsedSeconds = startElapsedSeconds + durationSeconds;
  if (!Number.isSafeInteger(endElapsedSeconds)) return planFailure("clock_overflow");

  const seenIds = new Set<string>();
  const copied: SchedulerEvent[] = [];
  for (const event of events) {
    if (!isSchedulerEvent(event)) return planFailure("invalid_event");
    if (seenIds.has(event.eventId)) return planFailure("duplicate_event_id", event.eventId);
    seenIds.add(event.eventId);
    if (event.atElapsedSeconds < startElapsedSeconds) return planFailure("past_event", event.eventId);
    copied.push(event);
  }

  copied.sort(compareSchedulerEvents);
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

/**
 * Applies one already-built time plan as a single Core transition. Due events
 * observe state changes from earlier due events. A terminal event is an explicit
 * successful interruption: it commits state at its own game-time and leaves all
 * later due events unprocessed. Any effect failure still exposes no partial state.
 */
export function applyTimeAdvancePlan(
  state: WorldState,
  plan: TimeAdvancePlanSuccess
): TimeAdvanceApplyResult {
  const startElapsedSeconds = state.clock?.elapsedSeconds;
  if (state.schemaVersion !== CONTRACT_SCHEMA_VERSION
    || !isSafeNonNegativeInteger(state.revision)
    || !isSafeNonNegativeInteger(startElapsedSeconds)) {
    return applyFailure("invalid_state");
  }
  if (state.terminal !== null) return applyFailure("already_terminal");
  if (!isValidPlanShape(plan)) return applyFailure("invalid_plan");
  if (plan.startElapsedSeconds !== startElapsedSeconds) {
    return applyFailure("plan_state_mismatch");
  }
  if (state.revision === Number.MAX_SAFE_INTEGER) return applyFailure("revision_overflow");

  let trialState = state;
  const appliedEvents: SchedulerEvent[] = [];
  let interrupted = false;
  let interruptionEventId: string | null = null;
  let effectiveEnd = plan.endElapsedSeconds;
  let unprocessedEvents: SchedulerEvent[] = [];

  for (let index = 0; index < plan.dueEvents.length; index += 1) {
    const event = plan.dueEvents[index];
    if (!event) return applyFailure("invalid_plan");

    if (event.kind === "core.effects") {
      const applied = tryApplyEffectBatch(trialState, event.payload.effects);
      if (!applied.ok) {
        return Object.freeze({
          ok: false,
          code: "event_effect_failed",
          eventIndex: index,
          eventId: event.eventId,
          effectFailure: applied
        });
      }
      trialState = applied.state;
    } else if (event.kind === "core.terminal") {
      trialState = Object.freeze({
        ...trialState,
        terminal: Object.freeze({
          reason: event.payload.reason,
          outcome: event.payload.outcome
        })
      });
      interrupted = true;
      interruptionEventId = event.eventId;
      effectiveEnd = event.atElapsedSeconds;
      appliedEvents.push(event);
      unprocessedEvents = [...plan.dueEvents.slice(index + 1)];
      break;
    }

    appliedEvents.push(event);
  }

  const nextState: WorldState = Object.freeze({
    ...trialState,
    revision: state.revision + 1,
    clock: Object.freeze({ elapsedSeconds: effectiveEnd })
  });

  return Object.freeze({
    ok: true,
    state: nextState,
    appliedEvents: Object.freeze([...appliedEvents]),
    pendingEvents: Object.freeze([...plan.pendingEvents]),
    interrupted,
    interruptionEventId,
    unprocessedEvents: Object.freeze(unprocessedEvents)
  });
}

export function compareSchedulerEvents(left: SchedulerEvent, right: SchedulerEvent): number {
  if (left.atElapsedSeconds < right.atElapsedSeconds) return -1;
  if (left.atElapsedSeconds > right.atElapsedSeconds) return 1;
  if (left.order < right.order) return -1;
  if (left.order > right.order) return 1;
  if (left.eventId < right.eventId) return -1;
  if (left.eventId > right.eventId) return 1;
  return 0;
}

/** Backward-compatible B03-01 export name. */
export const compareScheduledEvents = compareSchedulerEvents;

function isValidPlanShape(plan: TimeAdvancePlanSuccess): boolean {
  if (plan?.ok !== true
    || !isSafeNonNegativeInteger(plan.startElapsedSeconds)
    || !isSafeNonNegativeInteger(plan.endElapsedSeconds)
    || plan.endElapsedSeconds < plan.startElapsedSeconds
    || !Array.isArray(plan.dueEvents)
    || !Array.isArray(plan.pendingEvents)) {
    return false;
  }

  const allEvents = [...plan.dueEvents, ...plan.pendingEvents];
  if (!allEvents.every(isSchedulerEvent)) return false;
  const ids = new Set<string>();
  for (const event of allEvents) {
    if (ids.has(event.eventId)) return false;
    ids.add(event.eventId);
  }

  for (const event of plan.dueEvents) {
    if (event.atElapsedSeconds < plan.startElapsedSeconds
      || event.atElapsedSeconds > plan.endElapsedSeconds) return false;
  }
  for (const event of plan.pendingEvents) {
    if (event.atElapsedSeconds <= plan.endElapsedSeconds) return false;
  }

  return isSorted(plan.dueEvents) && isSorted(plan.pendingEvents);
}

function isSorted(events: readonly SchedulerEvent[]): boolean {
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];
    if (!previous || !current || compareSchedulerEvents(previous, current) > 0) return false;
  }
  return true;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function planFailure(code: TimeAdvanceFailureCode, eventId?: string): TimeAdvancePlanFailure {
  return eventId === undefined
    ? Object.freeze({ ok: false, code })
    : Object.freeze({ ok: false, code, eventId });
}

function applyFailure(code: TimeAdvanceApplyFailureCode): TimeAdvanceApplyFailure {
  return Object.freeze({ ok: false, code });
}
