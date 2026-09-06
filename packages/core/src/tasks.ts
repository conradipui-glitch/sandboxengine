import {
  CONTRACT_SCHEMA_VERSION,
  isScheduledTask,
  isSchedulerEvent,
  isScheduledTerminalEvent,
  type GameplayEffect,
  type ScheduledTask,
  type ScheduledTerminalEvent,
  type SchedulerEvent,
  type WorldState
} from "@living-history/contracts";
import {
  CORE_DEADLINE_PRIORITY,
  CORE_TASK_START_INTERNAL_ORDER,
  CORE_TASK_STEP_PRIORITY
} from "./scheduler.js";

export type TaskProjectionFailureCode =
  | "invalid_state"
  | "invalid_task"
  | "invalid_task_priority"
  | "actor_not_found"
  | "invalid_projected_event";

export interface TaskProjectionSuccess {
  readonly ok: true;
  readonly events: readonly SchedulerEvent[];
}

export interface TaskProjectionFailure {
  readonly ok: false;
  readonly code: TaskProjectionFailureCode;
}

export type TaskProjectionResult = TaskProjectionSuccess | TaskProjectionFailure;

export interface DeadlineDefinition {
  readonly deadlineId: string;
  readonly atElapsedSeconds: number;
  readonly order: number;
  readonly sourceId: string;
  readonly reason: string;
  readonly outcome: string;
}

export interface DeadlineProjectionSuccess {
  readonly ok: true;
  readonly event: ScheduledTerminalEvent;
}

export interface DeadlineProjectionFailure {
  readonly ok: false;
  readonly code: "invalid_deadline";
}

export type DeadlineProjectionResult = DeadlineProjectionSuccess | DeadlineProjectionFailure;

export function projectTaskEvents(state: WorldState, task: ScheduledTask): TaskProjectionResult {
  if (state.schemaVersion !== CONTRACT_SCHEMA_VERSION
    || !Number.isSafeInteger(state.clock?.elapsedSeconds)
    || state.clock.elapsedSeconds < 0
    || !Array.isArray(state.entities)) {
    return Object.freeze({ ok: false, code: "invalid_state" });
  }
  if (!isScheduledTask(task)) return Object.freeze({ ok: false, code: "invalid_task" });
  if (task.baseOrder !== CORE_TASK_START_INTERNAL_ORDER) {
    return Object.freeze({ ok: false, code: "invalid_task_priority" });
  }
  if (!state.entities.some((entity) => entity.id === task.actorEntityId)) {
    return Object.freeze({ ok: false, code: "actor_not_found" });
  }

  const start = buildTaskEvent(
    `${task.taskId}.start`,
    task.startAtElapsedSeconds,
    CORE_TASK_START_INTERNAL_ORDER,
    task.sourceId,
    "task.start",
    task.startEffects
  );
  const complete = buildTaskEvent(
    `${task.taskId}.complete`,
    task.completeAtElapsedSeconds,
    CORE_TASK_STEP_PRIORITY,
    task.sourceId,
    "task.complete",
    task.completionEffects
  );

  if (!isSchedulerEvent(start) || !isSchedulerEvent(complete)) {
    return Object.freeze({ ok: false, code: "invalid_projected_event" });
  }

  return Object.freeze({
    ok: true,
    events: Object.freeze([start, complete])
  });
}

export function projectDeadlineEvent(definition: DeadlineDefinition): DeadlineProjectionResult {
  if (definition.order !== CORE_DEADLINE_PRIORITY) {
    return Object.freeze({ ok: false, code: "invalid_deadline" });
  }
  const event = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    eventId: `${definition.deadlineId}.terminal`,
    atElapsedSeconds: definition.atElapsedSeconds,
    order: CORE_DEADLINE_PRIORITY,
    sourceId: definition.sourceId,
    kind: "core.terminal" as const,
    payload: {
      reason: definition.reason,
      outcome: definition.outcome
    }
  };

  if (!isScheduledTerminalEvent(event)) {
    return Object.freeze({ ok: false, code: "invalid_deadline" });
  }
  return Object.freeze({
    ok: true,
    event: freezeTerminalEvent(event)
  });
}

function buildTaskEvent(
  eventId: string,
  atElapsedSeconds: number,
  order: number,
  sourceId: string,
  markerId: string,
  effects: readonly GameplayEffect[]
): SchedulerEvent {
  if (effects.length === 0) {
    return Object.freeze({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      eventId,
      atElapsedSeconds,
      order,
      sourceId,
      kind: "core.marker" as const,
      payload: Object.freeze({ markerId })
    });
  }

  return Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    eventId,
    atElapsedSeconds,
    order,
    sourceId,
    kind: "core.effects" as const,
    payload: Object.freeze({
      effects: Object.freeze(effects.map(cloneEffect))
    })
  });
}

function cloneEffect(effect: GameplayEffect): GameplayEffect {
  if (effect.type === "item.transfer") {
    return Object.freeze({
      ...effect,
      destination: Object.freeze({ ...effect.destination })
    });
  }
  return Object.freeze({ ...effect });
}

function freezeTerminalEvent(event: ScheduledTerminalEvent): ScheduledTerminalEvent {
  return Object.freeze({
    ...event,
    payload: Object.freeze({ ...event.payload })
  });
}
