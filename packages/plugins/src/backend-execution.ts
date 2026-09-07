import type { PluginRegistrySnapshot } from "./index.js";
import {
  PLUGIN_EXECUTION_SCHEMA_VERSION,
  PLUGIN_MAX_DURATION_SECONDS,
  PLUGIN_MAX_EFFECTS_PER_ACTION,
  PLUGIN_MAX_EVENTS_PER_ACTION,
  PLUGIN_MAX_RNG_DRAWS,
  PLUGIN_MAX_UNITS,
  buildPluginExecutionRegistry as buildInternalRegistry,
  handleRegisteredPluginEvent as handleInternalEvent,
  resolveRegisteredPluginAction as resolveInternalAction,
  type PluginActionResolutionResult,
  type PluginExecutionRegistry,
  type PluginExecutionRegistryBuildResult,
  type PluginRngBackend,
  type PluginSchedulerHandlingResult,
  type TrustedPluginBackendRegistration
} from "./execution.js";
import type { JsonValue, SchedulerEvent, WorldState } from "@living-history/contracts";

export {
  PLUGIN_EXECUTION_SCHEMA_VERSION,
  PLUGIN_MAX_DURATION_SECONDS,
  PLUGIN_MAX_EFFECTS_PER_ACTION,
  PLUGIN_MAX_EVENTS_PER_ACTION,
  PLUGIN_MAX_RNG_DRAWS,
  PLUGIN_MAX_UNITS
};
export type {
  PluginActionPlan,
  PluginActionResolver,
  PluginActionResolverRegistration,
  PluginArgsValidator,
  PluginExecutionRegistry,
  PluginExecutionRegistryBuildResult,
  PluginResolverInput,
  PluginResolverRng,
  PluginRngBackend,
  PluginRngBackendResult,
  PluginRngProvenance,
  PluginSchedulerHandler,
  PluginSchedulerHandlerInput,
  PluginSchedulerHandlerRegistration,
  PluginSchedulerHandlingResult,
  TrustedPluginBackendRegistration,
  ValidatedPluginActionPlan
} from "./execution.js";

/** Public facade: wraps internal Maps without leaking the mutable backing map through forEach. */
export function buildPluginExecutionRegistry(
  pluginRegistry: PluginRegistrySnapshot,
  registrations: readonly TrustedPluginBackendRegistration[]
): PluginExecutionRegistryBuildResult {
  const built = buildInternalRegistry(pluginRegistry, registrations);
  if (!built.ok) return built;
  return Object.freeze({
    ok: true,
    registry: Object.freeze({
      pluginRegistry: built.registry.pluginRegistry,
      actionResolvers: safeReadonlyMap(built.registry.actionResolvers),
      schedulerHandlers: safeReadonlyMap(built.registry.schedulerHandlers)
    })
  });
}

export function resolveRegisteredPluginAction(input: {
  readonly registry: PluginExecutionRegistry;
  readonly actionTypeId: string;
  readonly state: WorldState;
  readonly args: unknown;
  readonly rng: PluginRngBackend;
}): PluginActionResolutionResult {
  const resolved = resolveInternalAction(input);
  if (!resolved.ok) return resolved;
  const plan = resolved.plan;
  if (plan.requestedUnits < 1) return invalidPlan();
  if (plan.status === "blocked") {
    if (plan.completedUnits !== 0
      || plan.durationSeconds !== 0
      || plan.effects.length !== 0
      || plan.scheduledEvents.length !== 0
      || plan.reasonCode === null) return invalidPlan();
  }
  if (plan.status === "partial" && plan.reasonCode === null) return invalidPlan();
  return resolved;
}

export function handleRegisteredPluginEvent(input: {
  readonly registry: PluginExecutionRegistry;
  readonly eventTypeId: string;
  readonly event: SchedulerEvent;
  readonly state: WorldState;
  readonly context: {
    readonly sequence: number;
    readonly effectiveOrder: number;
    readonly intervalEndElapsedSeconds: number;
  };
  readonly rng: PluginRngBackend;
}): PluginSchedulerHandlingResult {
  const handled = handleInternalEvent(input);
  if (!handled.ok) return handled;
  if (handled.events.some((event) => event.sourceId !== input.eventTypeId)) {
    return Object.freeze({ ok: false, code: "INVALID_GENERATED_EVENTS" });
  }
  return handled;
}

function invalidPlan(): PluginActionResolutionResult {
  return Object.freeze({ ok: false, code: "INVALID_PLAN" });
}

function safeReadonlyMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const entries = Object.freeze([...source.entries()]);
  const get = (key: K): V | undefined => entries.find(([candidate]) => Object.is(candidate, key) || candidate === key)?.[1];
  let facade: ReadonlyMap<K, V>;
  facade = Object.freeze({
    get,
    has(key: K) { return get(key) !== undefined; },
    entries() { return entries[Symbol.iterator](); },
    keys() { return entries.map(([key]) => key)[Symbol.iterator](); },
    values() { return entries.map(([, value]) => value)[Symbol.iterator](); },
    forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) {
      for (const [key, value] of entries) callbackfn.call(thisArg, value, key, facade);
    },
    get size() { return entries.length; },
    [Symbol.iterator]() { return entries[Symbol.iterator](); }
  } as ReadonlyMap<K, V>);
  return facade;
}
