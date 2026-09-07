import {
  CONTRACT_SCHEMA_VERSION,
  hasValidWorldStateReferences,
  isGameplayEffect,
  isSchedulerEvent,
  type GameplayEffect,
  type JsonValue,
  type SchedulerEvent,
  type WorldState
} from "@living-history/contracts";
import type { PluginManifest, PluginRegistrySnapshot } from "./index.js";

export const PLUGIN_EXECUTION_SCHEMA_VERSION = "1.0" as const;
export const PLUGIN_MAX_EFFECTS_PER_ACTION = 100;
export const PLUGIN_MAX_EVENTS_PER_ACTION = 100;
export const PLUGIN_MAX_DURATION_SECONDS = 86_400;
export const PLUGIN_MAX_UNITS = 1_000_000;
export const PLUGIN_MAX_RNG_DRAWS = 100;

export interface PluginRngProvenance {
  readonly algorithm: string;
  readonly seed: number;
  readonly streamId: string;
  readonly drawIndex: number;
  readonly rawUint32: number;
  readonly maxExclusive: number;
  readonly value: number;
}

export type PluginRngBackendResult =
  | { readonly ok: true; readonly value: number; readonly provenance: PluginRngProvenance }
  | { readonly ok: false; readonly code: string };

/** Host-owned deterministic RNG backend. Plugin code never receives its mutable state. */
export interface PluginRngBackend {
  drawInt(maxExclusive: number): PluginRngBackendResult;
}

/** Narrow RNG surface visible to trusted plugin code. */
export interface PluginResolverRng {
  drawInt(maxExclusive: number): number;
}

export interface PluginResolverInput {
  readonly pluginId: string;
  readonly actionTypeId: string;
  readonly state: WorldState;
  readonly args: JsonValue;
  readonly clock: { readonly elapsedSeconds: number };
  readonly rng: PluginResolverRng;
}

export interface PluginActionPlan {
  readonly schemaVersion: typeof PLUGIN_EXECUTION_SCHEMA_VERSION;
  readonly actionTypeId: string;
  readonly status: "executed" | "partial" | "blocked";
  readonly requestedUnits: number;
  readonly completedUnits: number;
  readonly durationSeconds: number;
  readonly reasonCode: string | null;
  readonly effects: readonly GameplayEffect[];
  readonly scheduledEvents: readonly SchedulerEvent[];
}

export interface ValidatedPluginActionPlan extends PluginActionPlan {
  readonly rngTrace: readonly PluginRngProvenance[];
}

export type PluginArgsValidator = (args: JsonValue) => boolean;
export type PluginActionResolver = (input: PluginResolverInput) => unknown;

export interface PluginActionResolverRegistration {
  readonly actionTypeId: string;
  readonly validateArgs: PluginArgsValidator;
  readonly resolve: PluginActionResolver;
}

export interface PluginSchedulerHandlerInput {
  readonly pluginId: string;
  readonly eventTypeId: string;
  readonly event: SchedulerEvent;
  readonly state: WorldState;
  readonly context: {
    readonly sequence: number;
    readonly effectiveOrder: number;
    readonly intervalEndElapsedSeconds: number;
  };
  readonly rng: PluginResolverRng;
}

export type PluginSchedulerHandler = (input: PluginSchedulerHandlerInput) => unknown;

export interface PluginSchedulerHandlerRegistration {
  readonly eventTypeId: string;
  readonly handle: PluginSchedulerHandler;
}

export interface TrustedPluginBackendRegistration {
  readonly pluginId: string;
  readonly actionResolvers: readonly PluginActionResolverRegistration[];
  readonly schedulerHandlers: readonly PluginSchedulerHandlerRegistration[];
}

export interface PluginExecutionRegistry {
  readonly pluginRegistry: PluginRegistrySnapshot;
  readonly actionResolvers: ReadonlyMap<string, Readonly<{
    pluginId: string;
    validateArgs: PluginArgsValidator;
    resolve: PluginActionResolver;
  }>>;
  readonly schedulerHandlers: ReadonlyMap<string, Readonly<{
    pluginId: string;
    handle: PluginSchedulerHandler;
  }>>;
}

export type PluginExecutionRegistryBuildResult =
  | { readonly ok: true; readonly registry: PluginExecutionRegistry }
  | {
      readonly ok: false;
      readonly code:
        | "INVALID_PLUGIN_REGISTRY"
        | "INVALID_REGISTRATION"
        | "PLUGIN_NOT_INSTALLED"
        | "ACTION_NOT_DECLARED"
        | "EVENT_NOT_DECLARED"
        | "DUPLICATE_ACTION_RESOLVER"
        | "DUPLICATE_EVENT_HANDLER";
      readonly pluginId?: string;
      readonly id?: string;
    };

export type PluginActionResolutionResult =
  | { readonly ok: true; readonly plan: ValidatedPluginActionPlan }
  | {
      readonly ok: false;
      readonly code:
        | "ACTION_NOT_REGISTERED"
        | "INVALID_STATE"
        | "INVALID_ARGS"
        | "ARG_VALIDATOR_FAILED"
        | "RESOLVER_FAILED"
        | "RNG_FAILED"
        | "RNG_DRAW_LIMIT_EXCEEDED"
        | "INVALID_PLAN";
    };

export type PluginSchedulerHandlingResult =
  | {
      readonly ok: true;
      readonly events: readonly SchedulerEvent[];
      readonly rngTrace: readonly PluginRngProvenance[];
    }
  | {
      readonly ok: false;
      readonly code:
        | "EVENT_HANDLER_NOT_REGISTERED"
        | "INVALID_STATE"
        | "INVALID_EVENT"
        | "INVALID_CONTEXT"
        | "HANDLER_FAILED"
        | "RNG_FAILED"
        | "RNG_DRAW_LIMIT_EXCEEDED"
        | "INVALID_GENERATED_EVENTS";
    };

export function buildPluginExecutionRegistry(
  pluginRegistry: PluginRegistrySnapshot,
  registrations: readonly TrustedPluginBackendRegistration[]
): PluginExecutionRegistryBuildResult {
  if (!isTrustedRegistryShape(pluginRegistry)) return executionRegistryFailure("INVALID_PLUGIN_REGISTRY");
  if (!Array.isArray(registrations) || registrations.length > pluginRegistry.plugins.length) {
    return executionRegistryFailure("INVALID_REGISTRATION");
  }

  const installed = new Map(pluginRegistry.plugins.map((plugin) => [plugin.pluginId, plugin]));
  const actionResolvers = new Map<string, { pluginId: string; validateArgs: PluginArgsValidator; resolve: PluginActionResolver }>();
  const schedulerHandlers = new Map<string, { pluginId: string; handle: PluginSchedulerHandler }>();
  const seenPlugins = new Set<string>();

  for (const registration of registrations) {
    if (!isRegistrationShape(registration) || seenPlugins.has(registration.pluginId)) {
      return executionRegistryFailure("INVALID_REGISTRATION", registration?.pluginId);
    }
    seenPlugins.add(registration.pluginId);
    const manifest = installed.get(registration.pluginId);
    if (!manifest) return executionRegistryFailure("PLUGIN_NOT_INSTALLED", registration.pluginId);

    const declaredActions = new Set(manifest.backend.actionTypeIds);
    for (const resolver of registration.actionResolvers) {
      if (!declaredActions.has(resolver.actionTypeId)) {
        return executionRegistryFailure("ACTION_NOT_DECLARED", registration.pluginId, resolver.actionTypeId);
      }
      if (actionResolvers.has(resolver.actionTypeId)) {
        return executionRegistryFailure("DUPLICATE_ACTION_RESOLVER", registration.pluginId, resolver.actionTypeId);
      }
      actionResolvers.set(resolver.actionTypeId, Object.freeze({
        pluginId: registration.pluginId,
        validateArgs: resolver.validateArgs,
        resolve: resolver.resolve
      }));
    }

    const declaredEvents = new Set(manifest.backend.scheduledEventTypeIds);
    for (const handler of registration.schedulerHandlers) {
      if (!declaredEvents.has(handler.eventTypeId)) {
        return executionRegistryFailure("EVENT_NOT_DECLARED", registration.pluginId, handler.eventTypeId);
      }
      if (schedulerHandlers.has(handler.eventTypeId)) {
        return executionRegistryFailure("DUPLICATE_EVENT_HANDLER", registration.pluginId, handler.eventTypeId);
      }
      schedulerHandlers.set(handler.eventTypeId, Object.freeze({
        pluginId: registration.pluginId,
        handle: handler.handle
      }));
    }
  }

  return Object.freeze({
    ok: true,
    registry: Object.freeze({
      pluginRegistry,
      actionResolvers: readonlyMap(actionResolvers),
      schedulerHandlers: readonlyMap(schedulerHandlers)
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
  const registration = input.registry.actionResolvers.get(input.actionTypeId);
  if (!registration) return Object.freeze({ ok: false, code: "ACTION_NOT_REGISTERED" });
  if (!isValidWorldState(input.state)) return Object.freeze({ ok: false, code: "INVALID_STATE" });
  if (!isJsonValue(input.args)) return Object.freeze({ ok: false, code: "INVALID_ARGS" });

  const args = deepFreeze(cloneJson(input.args));
  let argsValid = false;
  try {
    argsValid = registration.validateArgs(args);
  } catch {
    return Object.freeze({ ok: false, code: "ARG_VALIDATOR_FAILED" });
  }
  if (!argsValid) return Object.freeze({ ok: false, code: "INVALID_ARGS" });

  const state = deepFreeze(cloneWorldState(input.state));
  const rngTrace: PluginRngProvenance[] = [];
  let rngFailure: "RNG_FAILED" | "RNG_DRAW_LIMIT_EXCEEDED" | null = null;
  const rng: PluginResolverRng = Object.freeze({
    drawInt(maxExclusive: number): number {
      if (rngFailure !== null) throw new PluginRngExecutionError(rngFailure);
      if (rngTrace.length >= PLUGIN_MAX_RNG_DRAWS) {
        rngFailure = "RNG_DRAW_LIMIT_EXCEEDED";
        throw new PluginRngExecutionError(rngFailure);
      }
      let result: PluginRngBackendResult;
      try {
        result = input.rng.drawInt(maxExclusive);
      } catch {
        rngFailure = "RNG_FAILED";
        throw new PluginRngExecutionError(rngFailure);
      }
      if (!result.ok || !isRngProvenance(result.provenance) || result.value !== result.provenance.value) {
        rngFailure = "RNG_FAILED";
        throw new PluginRngExecutionError(rngFailure);
      }
      rngTrace.push(Object.freeze({ ...result.provenance }));
      return result.value;
    }
  });

  let rawPlan: unknown;
  try {
    rawPlan = registration.resolve(Object.freeze({
      pluginId: registration.pluginId,
      actionTypeId: input.actionTypeId,
      state,
      args,
      clock: Object.freeze({ elapsedSeconds: state.clock.elapsedSeconds }),
      rng
    }));
  } catch (error) {
    if (error instanceof PluginRngExecutionError) return Object.freeze({ ok: false, code: error.code });
    return Object.freeze({ ok: false, code: "RESOLVER_FAILED" });
  }
  if (rngFailure !== null) return Object.freeze({ ok: false, code: rngFailure });

  const plan = validatePluginActionPlan(rawPlan, registration.pluginId, input.actionTypeId);
  if (plan === null) return Object.freeze({ ok: false, code: "INVALID_PLAN" });
  return Object.freeze({
    ok: true,
    plan: deepFreeze({ ...plan, rngTrace: rngTrace.map((entry) => ({ ...entry })) })
  });
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
  const registration = input.registry.schedulerHandlers.get(input.eventTypeId);
  if (!registration) return Object.freeze({ ok: false, code: "EVENT_HANDLER_NOT_REGISTERED" });
  if (!isValidWorldState(input.state)) return Object.freeze({ ok: false, code: "INVALID_STATE" });
  if (!isSchedulerEvent(input.event)) return Object.freeze({ ok: false, code: "INVALID_EVENT" });
  if (!isSchedulerContext(input.context)) return Object.freeze({ ok: false, code: "INVALID_CONTEXT" });

  const state = deepFreeze(cloneWorldState(input.state));
  const event = deepFreeze(cloneJson(input.event as unknown as JsonValue) as unknown as SchedulerEvent);
  const rngTrace: PluginRngProvenance[] = [];
  let rngFailure: "RNG_FAILED" | "RNG_DRAW_LIMIT_EXCEEDED" | null = null;
  const rng: PluginResolverRng = Object.freeze({
    drawInt(maxExclusive: number): number {
      if (rngTrace.length >= PLUGIN_MAX_RNG_DRAWS) {
        rngFailure = "RNG_DRAW_LIMIT_EXCEEDED";
        throw new PluginRngExecutionError(rngFailure);
      }
      let result: PluginRngBackendResult;
      try { result = input.rng.drawInt(maxExclusive); }
      catch {
        rngFailure = "RNG_FAILED";
        throw new PluginRngExecutionError(rngFailure);
      }
      if (!result.ok || !isRngProvenance(result.provenance) || result.value !== result.provenance.value) {
        rngFailure = "RNG_FAILED";
        throw new PluginRngExecutionError(rngFailure);
      }
      rngTrace.push(Object.freeze({ ...result.provenance }));
      return result.value;
    }
  });

  let raw: unknown;
  try {
    raw = registration.handle(Object.freeze({
      pluginId: registration.pluginId,
      eventTypeId: input.eventTypeId,
      event,
      state,
      context: Object.freeze({ ...input.context }),
      rng
    }));
  } catch (error) {
    if (error instanceof PluginRngExecutionError) return Object.freeze({ ok: false, code: error.code });
    return Object.freeze({ ok: false, code: "HANDLER_FAILED" });
  }
  if (rngFailure !== null) return Object.freeze({ ok: false, code: rngFailure });
  if (!Array.isArray(raw) || raw.length > PLUGIN_MAX_EVENTS_PER_ACTION || !raw.every(isSchedulerEvent)) {
    return Object.freeze({ ok: false, code: "INVALID_GENERATED_EVENTS" });
  }
  return Object.freeze({
    ok: true,
    events: deepFreeze(raw.map((entry) => cloneJson(entry as unknown as JsonValue) as unknown as SchedulerEvent)),
    rngTrace: deepFreeze(rngTrace.map((entry) => ({ ...entry })))
  });
}

function validatePluginActionPlan(raw: unknown, pluginId: string, actionTypeId: string): PluginActionPlan | null {
  if (!isPlainObject(raw) || !hasExactKeys(raw, [
    "schemaVersion", "actionTypeId", "status", "requestedUnits", "completedUnits",
    "durationSeconds", "reasonCode", "effects", "scheduledEvents"
  ])) return null;
  if (raw.schemaVersion !== PLUGIN_EXECUTION_SCHEMA_VERSION || raw.actionTypeId !== actionTypeId) return null;
  if (!(["executed", "partial", "blocked"] as const).includes(raw.status as any)) return null;
  if (!isBoundedNonNegativeInteger(raw.requestedUnits, PLUGIN_MAX_UNITS)
    || !isBoundedNonNegativeInteger(raw.completedUnits, PLUGIN_MAX_UNITS)
    || raw.completedUnits > raw.requestedUnits) return null;
  if (raw.status === "blocked" && raw.completedUnits !== 0) return null;
  if (raw.status === "executed" && raw.completedUnits !== raw.requestedUnits) return null;
  if (raw.status === "partial" && !(raw.completedUnits > 0 && raw.completedUnits < raw.requestedUnits)) return null;
  if (!isBoundedNonNegativeInteger(raw.durationSeconds, PLUGIN_MAX_DURATION_SECONDS)) return null;
  if (!(raw.reasonCode === null || (typeof raw.reasonCode === "string" && raw.reasonCode.length >= 1 && raw.reasonCode.length <= 200))) return null;
  if (!Array.isArray(raw.effects) || raw.effects.length > PLUGIN_MAX_EFFECTS_PER_ACTION || !raw.effects.every(isGameplayEffect)) return null;
  if (!Array.isArray(raw.scheduledEvents) || raw.scheduledEvents.length > PLUGIN_MAX_EVENTS_PER_ACTION || !raw.scheduledEvents.every(isSchedulerEvent)) return null;

  for (const effect of raw.effects) {
    if (effect.sourceId !== actionTypeId || !actionTypeId.startsWith(`${pluginId}.`)) return null;
  }
  for (const event of raw.scheduledEvents) {
    if (event.sourceId !== actionTypeId) return null;
  }

  return deepFreeze({
    schemaVersion: PLUGIN_EXECUTION_SCHEMA_VERSION,
    actionTypeId,
    status: raw.status as PluginActionPlan["status"],
    requestedUnits: raw.requestedUnits,
    completedUnits: raw.completedUnits,
    durationSeconds: raw.durationSeconds,
    reasonCode: raw.reasonCode as string | null,
    effects: raw.effects.map((entry) => cloneJson(entry as unknown as JsonValue) as unknown as GameplayEffect),
    scheduledEvents: raw.scheduledEvents.map((entry) => cloneJson(entry as unknown as JsonValue) as unknown as SchedulerEvent)
  });
}

function isTrustedRegistryShape(value: PluginRegistrySnapshot): boolean {
  return isPlainObject(value)
    && typeof value.enginePluginApiVersion === "string"
    && Array.isArray(value.plugins)
    && Array.isArray(value.pluginOrder)
    && value.plugins.length === value.pluginOrder.length;
}

function isRegistrationShape(value: TrustedPluginBackendRegistration): boolean {
  return isPlainObject(value)
    && hasExactKeys(value as unknown as Record<string, unknown>, ["pluginId", "actionResolvers", "schedulerHandlers"])
    && typeof value.pluginId === "string"
    && Array.isArray(value.actionResolvers)
    && Array.isArray(value.schedulerHandlers)
    && value.actionResolvers.length <= 256
    && value.schedulerHandlers.length <= 256
    && value.actionResolvers.every((entry) => isPlainObject(entry)
      && hasExactKeys(entry as unknown as Record<string, unknown>, ["actionTypeId", "validateArgs", "resolve"])
      && typeof entry.actionTypeId === "string"
      && typeof entry.validateArgs === "function"
      && typeof entry.resolve === "function")
    && value.schedulerHandlers.every((entry) => isPlainObject(entry)
      && hasExactKeys(entry as unknown as Record<string, unknown>, ["eventTypeId", "handle"])
      && typeof entry.eventTypeId === "string"
      && typeof entry.handle === "function");
}

function isValidWorldState(value: WorldState): boolean {
  return value?.schemaVersion === CONTRACT_SCHEMA_VERSION && hasValidWorldStateReferences(value);
}

function cloneWorldState(state: WorldState): WorldState {
  return cloneJson(state as unknown as JsonValue) as unknown as WorldState;
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.length <= 1000 && value.every((entry) => isJsonValue(entry, depth + 1));
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length <= 1000 && keys.every((key) => key.length <= 200 && isJsonValue(value[key], depth + 1));
}

function isRngProvenance(value: PluginRngProvenance): boolean {
  return isPlainObject(value)
    && typeof value.algorithm === "string" && value.algorithm.length >= 1 && value.algorithm.length <= 100
    && Number.isSafeInteger(value.seed) && value.seed >= 0
    && typeof value.streamId === "string" && value.streamId.length >= 1 && value.streamId.length <= 200
    && Number.isSafeInteger(value.drawIndex) && value.drawIndex >= 0
    && Number.isSafeInteger(value.rawUint32) && value.rawUint32 >= 0 && value.rawUint32 <= 0xffff_ffff
    && Number.isSafeInteger(value.maxExclusive) && value.maxExclusive >= 1 && value.maxExclusive <= 0x1_0000_0000
    && Number.isSafeInteger(value.value) && value.value >= 0 && value.value < value.maxExclusive;
}

function isSchedulerContext(value: PluginSchedulerHandlerInput["context"]): boolean {
  return isPlainObject(value)
    && Number.isSafeInteger(value.sequence) && value.sequence >= 0
    && Number.isSafeInteger(value.effectiveOrder) && value.effectiveOrder >= 0
    && Number.isSafeInteger(value.intervalEndElapsedSeconds) && value.intervalEndElapsedSeconds >= 0;
}

function isBoundedNonNegativeInteger(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readonlyMap<K, V>(source: Map<K, V>): ReadonlyMap<K, V> {
  const snapshot = new Map(source);
  return Object.freeze({
    get: snapshot.get.bind(snapshot),
    has: snapshot.has.bind(snapshot),
    entries: snapshot.entries.bind(snapshot),
    keys: snapshot.keys.bind(snapshot),
    values: snapshot.values.bind(snapshot),
    forEach: snapshot.forEach.bind(snapshot),
    get size() { return snapshot.size; },
    [Symbol.iterator]: snapshot[Symbol.iterator].bind(snapshot)
  } as ReadonlyMap<K, V>);
}

function executionRegistryFailure(
  code: Exclude<PluginExecutionRegistryBuildResult, { ok: true }>["code"],
  pluginId?: string,
  id?: string
): PluginExecutionRegistryBuildResult {
  return Object.freeze({ ok: false, code, ...(pluginId ? { pluginId } : {}), ...(id ? { id } : {}) });
}

class PluginRngExecutionError extends Error {
  constructor(readonly code: "RNG_FAILED" | "RNG_DRAW_LIMIT_EXCEEDED") {
    super(code);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
