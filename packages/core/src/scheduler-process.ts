import {
  CONTRACT_SCHEMA_VERSION,
  hasValidWorldStateReferences,
  isSchedulerEvent,
  type SchedulerEvent,
  type WorldState
} from "@living-history/contracts";
import { canonicalStringify } from "./compile.js";
import { tryApplyEffectBatch, type EffectBatchFailure } from "./effects.js";
import {
  HARD_MAX_EVENTS_PER_INTERVAL,
  compareSchedulerEvents,
  planTimeAdvance,
  type TimeAdvancePlanSuccess
} from "./scheduler.js";

export const DEFAULT_MAX_SCHEDULER_STEPS = 200;
export const HARD_MAX_SCHEDULER_STEPS = 2000;
export const DEFAULT_MAX_SCHEDULER_EVENTS = 200;
export const HARD_MAX_SCHEDULER_EVENTS = 2000;

export interface SchedulerProcessingContext {
  readonly sequence: number;
  readonly effectiveOrder: number;
  readonly intervalEndElapsedSeconds: number;
}

/**
 * Trusted deterministic boundary for Core/B08 integration. A handler may only
 * propose more strict SchedulerEvents; it receives a frozen snapshot and cannot
 * return state patches or mutate Core state directly.
 */
export type SchedulerEventHandler = (
  event: SchedulerEvent,
  state: WorldState,
  context: SchedulerProcessingContext
) => readonly SchedulerEvent[];

export interface SchedulerProcessingOptions {
  readonly maxSteps?: number;
  readonly maxEvents?: number;
  readonly handler?: SchedulerEventHandler;
}

export interface ProcessedSchedulerEvent {
  readonly event: SchedulerEvent;
  readonly sequence: number;
  readonly effectiveOrder: number;
}

export type SchedulerProcessingFailureCode =
  | "invalid_state"
  | "already_terminal"
  | "invalid_plan"
  | "plan_state_mismatch"
  | "invalid_options"
  | "revision_overflow"
  | "event_effect_failed"
  | "handler_failed"
  | "generated_event_invalid"
  | "generated_event_duplicate"
  | "generated_event_in_past"
  | "event_limit_exceeded"
  | "step_limit_exceeded";

export interface SchedulerProcessingSuccess {
  readonly ok: true;
  readonly state: WorldState;
  readonly processedEvents: readonly ProcessedSchedulerEvent[];
  readonly appliedEvents: readonly SchedulerEvent[];
  readonly pendingEvents: readonly SchedulerEvent[];
  readonly interrupted: boolean;
  readonly interruptionEventId: string | null;
  readonly unprocessedEvents: readonly SchedulerEvent[];
}

export interface SchedulerProcessingFailure {
  readonly ok: false;
  readonly code: SchedulerProcessingFailureCode;
  readonly eventId?: string;
  readonly stepCount?: number;
  readonly eventCount?: number;
  readonly maxSteps?: number;
  readonly maxEvents?: number;
  readonly effectFailure?: EffectBatchFailure;
}

export type SchedulerProcessingResult = SchedulerProcessingSuccess | SchedulerProcessingFailure;

interface QueueEntry {
  readonly event: SchedulerEvent;
  readonly effectiveOrder: number;
  readonly sequence: number;
}

/**
 * Processes a previously validated static plan plus deterministic child events
 * as one trial transition. A failure never exposes candidate state. Existing
 * planTimeAdvance semantics remain unchanged; this is the dynamic B03 layer.
 */
export function processTimeAdvancePlan(
  state: WorldState,
  plan: TimeAdvancePlanSuccess,
  options: SchedulerProcessingOptions = {}
): SchedulerProcessingResult {
  if (state.schemaVersion !== CONTRACT_SCHEMA_VERSION
    || !hasValidWorldStateReferences(state)
    || !isSafeNonNegativeInteger(state.revision)
    || !isSafeNonNegativeInteger(state.clock?.elapsedSeconds)) {
    return failure("invalid_state");
  }
  if (state.terminal !== null) return failure("already_terminal");
  if (!isSafeNonNegativeInteger(plan?.startElapsedSeconds)
    || !isSafeNonNegativeInteger(plan?.endElapsedSeconds)
    || plan.endElapsedSeconds < plan.startElapsedSeconds) {
    return failure("invalid_plan");
  }
  if (plan.startElapsedSeconds !== state.clock.elapsedSeconds) {
    return failure("plan_state_mismatch");
  }
  if (state.revision === Number.MAX_SAFE_INTEGER) return failure("revision_overflow");

  const maxSteps = options.maxSteps ?? DEFAULT_MAX_SCHEDULER_STEPS;
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_SCHEDULER_EVENTS;
  if (!isBoundedPositiveInteger(maxSteps, HARD_MAX_SCHEDULER_STEPS)
    || !isBoundedPositiveInteger(maxEvents, HARD_MAX_SCHEDULER_EVENTS)) {
    return failure("invalid_options");
  }

  if (!matchesCanonicalPlan(state, plan)) return failure("invalid_plan");

  const initialEvents = [...plan.dueEvents, ...plan.pendingEvents];
  if (initialEvents.length > maxEvents) {
    return Object.freeze({
      ok: false,
      code: "event_limit_exceeded",
      eventCount: initialEvents.length,
      maxEvents
    });
  }

  const seenIds = new Set(initialEvents.map((event) => event.eventId));
  let nextSequence = 0;
  const queue: QueueEntry[] = plan.dueEvents.map((event) => Object.freeze({
    event,
    effectiveOrder: event.order,
    sequence: nextSequence++
  }));
  const pendingEvents: SchedulerEvent[] = [...plan.pendingEvents];
  const processedEvents: ProcessedSchedulerEvent[] = [];
  const appliedEvents: SchedulerEvent[] = [];
  let trialState = state;
  let interrupted = false;
  let interruptionEventId: string | null = null;
  let effectiveEnd = plan.endElapsedSeconds;
  let unprocessedEvents: SchedulerEvent[] = [];
  let totalEventCount = initialEvents.length;

  queue.sort(compareQueueEntries);

  while (queue.length > 0) {
    if (processedEvents.length >= maxSteps) {
      return Object.freeze({
        ok: false,
        code: "step_limit_exceeded",
        stepCount: processedEvents.length,
        maxSteps
      });
    }

    const entry = queue.shift();
    if (!entry) return failure("invalid_plan");
    const event = entry.event;

    if (event.kind === "core.effects") {
      const effectResult = tryApplyEffectBatch(trialState, event.payload.effects);
      if (!effectResult.ok) {
        return Object.freeze({
          ok: false,
          code: "event_effect_failed",
          eventId: event.eventId,
          effectFailure: effectResult
        });
      }
      trialState = effectResult.state;
    } else if (event.kind === "core.terminal") {
      trialState = Object.freeze({
        ...trialState,
        terminal: Object.freeze({
          reason: event.payload.reason,
          outcome: event.payload.outcome
        })
      });
      processedEvents.push(freezeProcessed(entry));
      appliedEvents.push(event);
      interrupted = true;
      interruptionEventId = event.eventId;
      effectiveEnd = event.atElapsedSeconds;
      unprocessedEvents = queue.sort(compareQueueEntries).map((queued) => queued.event);
      break;
    }

    processedEvents.push(freezeProcessed(entry));
    appliedEvents.push(event);

    if (options.handler !== undefined) {
      let children: readonly SchedulerEvent[];
      try {
        children = options.handler(
          event,
          frozenStateSnapshot(trialState),
          Object.freeze({
            sequence: entry.sequence,
            effectiveOrder: entry.effectiveOrder,
            intervalEndElapsedSeconds: plan.endElapsedSeconds
          })
        );
      } catch {
        return failure("handler_failed", event.eventId);
      }
      if (!Array.isArray(children)) return failure("handler_failed", event.eventId);

      for (const child of children) {
        if (!isSchedulerEvent(child)) return failure("generated_event_invalid", event.eventId);
        if (seenIds.has(child.eventId)) return failure("generated_event_duplicate", child.eventId);
        if (child.atElapsedSeconds < event.atElapsedSeconds) {
          return failure("generated_event_in_past", child.eventId);
        }
        if (totalEventCount >= maxEvents) {
          return Object.freeze({
            ok: false,
            code: "event_limit_exceeded",
            eventCount: totalEventCount + 1,
            maxEvents
          });
        }

        seenIds.add(child.eventId);
        totalEventCount += 1;
        const effectiveOrder = child.atElapsedSeconds === event.atElapsedSeconds
          ? Math.max(child.order, entry.effectiveOrder)
          : child.order;
        const childEntry = Object.freeze({
          event: child,
          effectiveOrder,
          sequence: nextSequence++
        });

        if (child.atElapsedSeconds <= plan.endElapsedSeconds) {
          queue.push(childEntry);
          queue.sort(compareQueueEntries);
        } else {
          pendingEvents.push(child);
          pendingEvents.sort(compareSchedulerEvents);
        }
      }
    }
  }

  const nextState: WorldState = Object.freeze({
    ...trialState,
    revision: state.revision + 1,
    clock: Object.freeze({ elapsedSeconds: effectiveEnd })
  });

  return Object.freeze({
    ok: true,
    state: nextState,
    processedEvents: Object.freeze([...processedEvents]),
    appliedEvents: Object.freeze([...appliedEvents]),
    pendingEvents: Object.freeze([...pendingEvents]),
    interrupted,
    interruptionEventId,
    unprocessedEvents: Object.freeze([...unprocessedEvents])
  });
}

function matchesCanonicalPlan(state: WorldState, plan: TimeAdvancePlanSuccess): boolean {
  if (!Array.isArray(plan.dueEvents) || !Array.isArray(plan.pendingEvents)) return false;
  const duration = plan.endElapsedSeconds - plan.startElapsedSeconds;
  const rebuilt = planTimeAdvance(
    state,
    duration,
    [...plan.dueEvents, ...plan.pendingEvents],
    { maxEvents: HARD_MAX_EVENTS_PER_INTERVAL }
  );
  if (!rebuilt.ok) return false;
  return canonicalStringify(rebuilt) === canonicalStringify(plan);
}

function compareQueueEntries(left: QueueEntry, right: QueueEntry): number {
  if (left.event.atElapsedSeconds !== right.event.atElapsedSeconds) {
    return left.event.atElapsedSeconds - right.event.atElapsedSeconds;
  }
  if (left.effectiveOrder !== right.effectiveOrder) {
    return left.effectiveOrder - right.effectiveOrder;
  }
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  return left.event.eventId.localeCompare(right.event.eventId);
}

function freezeProcessed(entry: QueueEntry): ProcessedSchedulerEvent {
  return Object.freeze({
    event: entry.event,
    sequence: entry.sequence,
    effectiveOrder: entry.effectiveOrder
  });
}

function frozenStateSnapshot(state: WorldState): WorldState {
  return deepFreeze(JSON.parse(JSON.stringify(state)) as WorldState);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedPositiveInteger(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max;
}

function failure(code: SchedulerProcessingFailureCode, eventId?: string): SchedulerProcessingFailure {
  return eventId === undefined
    ? Object.freeze({ ok: false, code })
    : Object.freeze({ ok: false, code, eventId });
}
