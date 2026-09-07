import type { JsonValue, SchedulerEvent, WorldState } from "@living-history/contracts";
import {
  applyTimeAdvancePlan,
  drawDeterministicInt,
  planTimeAdvance,
  processTimeAdvancePlan,
  tryApplyEffectBatch,
  type DeterministicRngState,
  type EffectBatchFailure,
  type SchedulerProcessingSuccess,
  type TimeAdvancePlanSuccess
} from "@living-history/core";
import {
  handleRegisteredPluginEvent,
  resolveRegisteredPluginAction,
  type PluginActionResolutionResult,
  type PluginExecutionRegistry,
  type PluginRngBackend,
  type PluginSchedulerHandlingResult,
  type ValidatedPluginActionPlan
} from "@living-history/plugins/execution";

export type PluginCoreExecutionFailureCode =
  | "plugin_resolution_failed"
  | "effect_application_failed"
  | "time_planning_failed"
  | "time_application_failed";

export type PluginCoreExecutionResult =
  | {
      readonly ok: true;
      readonly candidateState: WorldState;
      readonly plan: ValidatedPluginActionPlan;
      readonly rngState: DeterministicRngState;
    }
  | {
      readonly ok: false;
      readonly code: PluginCoreExecutionFailureCode;
      readonly pluginFailure?: Exclude<PluginActionResolutionResult, { ok: true }>;
      readonly effectFailure?: EffectBatchFailure;
      readonly coreCode?: string;
    };

export type PluginSchedulerCoreProcessingResult =
  | {
      readonly ok: true;
      readonly processing: SchedulerProcessingSuccess;
      readonly rngState: DeterministicRngState;
    }
  | {
      readonly ok: false;
      readonly code: "scheduler_processing_failed";
      readonly coreCode: string;
      readonly eventId?: string;
    };

/**
 * Generic B08 action host. It owns RNG/effect/time authority and never exposes
 * those Core mutation functions to plugin code.
 */
export function executeRegisteredPluginActionThroughCore(input: {
  readonly registry: PluginExecutionRegistry;
  readonly actionTypeId: string;
  readonly state: WorldState;
  readonly args: JsonValue;
  readonly rngState: DeterministicRngState;
}): PluginCoreExecutionResult {
  let rngState = input.rngState;
  const rngBackend: PluginRngBackend = Object.freeze({
    drawInt(maxExclusive: number) {
      const drawn = drawDeterministicInt(rngState, maxExclusive);
      if (!drawn.ok) return Object.freeze({ ok: false as const, code: drawn.code });
      rngState = drawn.state;
      return Object.freeze({
        ok: true as const,
        value: drawn.provenance.value,
        provenance: Object.freeze({ ...drawn.provenance })
      });
    }
  });

  const resolved = resolveRegisteredPluginAction({
    registry: input.registry,
    actionTypeId: input.actionTypeId,
    state: input.state,
    args: input.args,
    rng: rngBackend
  });
  if (!resolved.ok) {
    return Object.freeze({ ok: false, code: "plugin_resolution_failed", pluginFailure: resolved });
  }

  const applied = tryApplyEffectBatch(input.state, resolved.plan.effects);
  if (!applied.ok) {
    return Object.freeze({ ok: false, code: "effect_application_failed", effectFailure: applied });
  }

  const timePlan = planTimeAdvance(applied.state, resolved.plan.durationSeconds, resolved.plan.scheduledEvents);
  if (!timePlan.ok) {
    return Object.freeze({ ok: false, code: "time_planning_failed", coreCode: timePlan.code });
  }
  const advanced = applyTimeAdvancePlan(applied.state, timePlan);
  if (!advanced.ok) {
    return Object.freeze({ ok: false, code: "time_application_failed", coreCode: advanced.code });
  }

  return Object.freeze({
    ok: true,
    candidateState: advanced.state,
    plan: resolved.plan,
    rngState
  });
}

/**
 * Generic trusted scheduler-handler boundary. Dispatch identity is supplied by
 * the caller/compiled plugin metadata; canonical SchedulerEvents stay canonical.
 */
export function executeRegisteredPluginSchedulerHandler(input: {
  readonly registry: PluginExecutionRegistry;
  readonly eventTypeId: string;
  readonly event: SchedulerEvent;
  readonly state: WorldState;
  readonly context: {
    readonly sequence: number;
    readonly effectiveOrder: number;
    readonly intervalEndElapsedSeconds: number;
  };
  readonly rngState: DeterministicRngState;
}): PluginSchedulerHandlingResult & { readonly rngState?: DeterministicRngState } {
  let rngState = input.rngState;
  const rngBackend: PluginRngBackend = Object.freeze({
    drawInt(maxExclusive: number) {
      const drawn = drawDeterministicInt(rngState, maxExclusive);
      if (!drawn.ok) return Object.freeze({ ok: false as const, code: drawn.code });
      rngState = drawn.state;
      return Object.freeze({
        ok: true as const,
        value: drawn.provenance.value,
        provenance: Object.freeze({ ...drawn.provenance })
      });
    }
  });

  const handled = handleRegisteredPluginEvent({
    registry: input.registry,
    eventTypeId: input.eventTypeId,
    event: input.event,
    state: input.state,
    context: input.context,
    rng: rngBackend
  });
  return handled.ok
    ? Object.freeze({ ...handled, rngState })
    : handled;
}

/**
 * Routes trusted plugin scheduler handlers through the existing Core dynamic
 * scheduler. Core remains authoritative for child-event validity, duplicate/past
 * checks, effective ordering, event/step budgets and the final state transition.
 * RNG advancement is published only with a successful Core transition.
 */
export function processRegisteredPluginSchedulerThroughCore(input: {
  readonly registry: PluginExecutionRegistry;
  readonly state: WorldState;
  readonly plan: TimeAdvancePlanSuccess;
  readonly rngState: DeterministicRngState;
  readonly resolveEventTypeId: (event: SchedulerEvent) => string | null;
}): PluginSchedulerCoreProcessingResult {
  let rngState = input.rngState;
  const processing = processTimeAdvancePlan(input.state, input.plan, {
    handler(event, state, context) {
      const eventTypeId = input.resolveEventTypeId(event);
      if (eventTypeId === null) return Object.freeze([]);
      if (typeof eventTypeId !== "string" || eventTypeId.length < 1 || eventTypeId.length > 200) {
        throw new TypeError("invalid plugin scheduler event type id");
      }
      const handled = executeRegisteredPluginSchedulerHandler({
        registry: input.registry,
        eventTypeId,
        event,
        state,
        context,
        rngState
      });
      if (!handled.ok || handled.rngState === undefined) {
        throw new Error("plugin scheduler handler failed");
      }
      rngState = handled.rngState;
      return handled.events;
    }
  });

  if (!processing.ok) {
    return Object.freeze({
      ok: false,
      code: "scheduler_processing_failed",
      coreCode: processing.code,
      ...(processing.eventId === undefined ? {} : { eventId: processing.eventId })
    });
  }

  return Object.freeze({ ok: true, processing, rngState });
}
