import type { IntentActionCatalogEntry } from "@living-history/ai";
import type { Condition, JsonValue, ResolvedIntent, WorldState, WorldTerminal } from "@living-history/contracts";
import { evaluateCondition, tryApplyEffectBatch } from "@living-history/core";
import { isPlainObject, hasExactKeys, cloneJson } from "./input-guards.js";

export const AUTHORED_SCENARIO_SIDECAR_KIND = "core.authored-scenario" as const;
export const AUTHORED_SCENARIO_FORMAT = "living-history.authored-scenario/1" as const;
export const AUTHORED_OPTION_ACTION_TYPE = "authored.option" as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_BEATS = 100;
const MAX_OPTIONS_PER_BEAT = 20;
const MAX_CASES_PER_OPTION = 20;
const MAX_EFFECTS_PER_OPTION = 100;
const MAX_CLOCK_ADVANCE_SECONDS = 31_536_000;

export type AuthoredOptionStatus = "executed" | "conditional" | "blocked";

export interface AuthoredScenarioOptionCase {
  readonly when: Condition;
  readonly status: AuthoredOptionStatus;
  readonly effects: readonly unknown[];
  readonly terminal?: WorldTerminal;
}

export interface AuthoredScenarioOption {
  readonly id: string;
  readonly status: AuthoredOptionStatus;
  readonly clockAdvanceSeconds: number;
  readonly effects: readonly unknown[];
  readonly terminal?: WorldTerminal;
  readonly cases?: readonly AuthoredScenarioOptionCase[];
  readonly meaning?: string;
}

export interface AuthoredScenarioBeat {
  readonly id: string;
  readonly title?: string;
  readonly options: readonly AuthoredScenarioOption[];
}

export interface AuthoredScenarioSidecarData {
  readonly format: typeof AUTHORED_SCENARIO_FORMAT;
  readonly artifactHash: string;
  readonly questId: string;
  readonly initialState: WorldState;
  readonly beats: readonly AuthoredScenarioBeat[];
}

export interface AuthoredScenarioSidecar {
  readonly kind: typeof AUTHORED_SCENARIO_SIDECAR_KIND;
  readonly data: AuthoredScenarioSidecarData;
}

export type AuthoredScenarioExecution =
  | {
      readonly committed: true;
      readonly optionId: string;
      readonly beatId: string;
      readonly status: "executed" | "conditional";
      readonly durationSeconds: number;
      readonly reasonCode: null;
      readonly candidateState: WorldState;
    }
  | {
      readonly committed: false;
      readonly optionId: string | null;
      readonly beatId: string | null;
      readonly status: "blocked";
      readonly durationSeconds: 0;
      readonly reasonCode: string;
      readonly candidateState: null;
    };

type ResolvedOption = {
  readonly ok: true;
  readonly status: AuthoredOptionStatus;
  readonly effects: readonly unknown[];
  readonly terminal: WorldTerminal | null;
} | {
  readonly ok: false;
  readonly code: string;
};

export function createAuthoredScenarioSidecar(input: {
  readonly artifactHash: string;
  readonly questId: string;
  readonly initialState: WorldState;
  readonly beats: unknown;
}): AuthoredScenarioSidecar | null {
  const normalized = normalizeScenario({
    format: AUTHORED_SCENARIO_FORMAT,
    artifactHash: input.artifactHash,
    questId: input.questId,
    initialState: input.initialState,
    beats: extractBeats(input.beats)
  });
  return normalized === null
    ? null
    : deepFreeze({ kind: AUTHORED_SCENARIO_SIDECAR_KIND, data: normalized });
}

export function bindAuthoredScenarioSidecar(
  value: unknown,
  artifactHash: string,
  questId: string
): AuthoredScenarioSidecarData | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ["kind", "data"])) return null;
  if (value.kind !== AUTHORED_SCENARIO_SIDECAR_KIND) return null;
  const normalized = normalizeScenario(value.data);
  if (normalized === null || normalized.artifactHash !== artifactHash || normalized.questId !== questId) return null;
  return normalized;
}

export function createAuthoredIntentCatalog(
  scenario: AuthoredScenarioSidecarData,
  state: WorldState
): readonly IntentActionCatalogEntry[] {
  const beat = currentBeat(scenario, state);
  if (!beat || state.terminal !== null) return Object.freeze([]);
  return Object.freeze([
    Object.freeze({
      actionType: AUTHORED_OPTION_ACTION_TYPE,
      args: Object.freeze({
        optionId: Object.freeze({
          type: "string" as const,
          enum: Object.freeze(beat.options.map((option) => option.id))
        })
      }),
      participantIds: Object.freeze([]),
      targetIds: Object.freeze([])
    })
  ]);
}

export function executeAuthoredIntent(
  scenario: AuthoredScenarioSidecarData,
  state: WorldState,
  intent: ResolvedIntent
): AuthoredScenarioExecution {
  if (intent.actionType !== AUTHORED_OPTION_ACTION_TYPE) {
    return blocked(null, null, "ACTION_TYPE_NOT_SUPPORTED");
  }
  const optionId = intent.args.optionId;
  if (typeof optionId !== "string") return blocked(null, null, "OPTION_ID_REQUIRED");
  return executeAuthoredOption(scenario, state, optionId);
}

export function executeAuthoredOption(
  scenario: AuthoredScenarioSidecarData,
  state: WorldState,
  optionId: string
): AuthoredScenarioExecution {
  if (!ID.test(optionId)) return blocked(null, null, "INVALID_OPTION_ID");
  if (tryApplyEffectBatch(state, []).ok !== true) return blocked(optionId, null, "INVALID_STATE");
  if (state.terminal !== null) return blocked(optionId, null, "SCENARIO_TERMINAL");
  if (state.revision === Number.MAX_SAFE_INTEGER) return blocked(optionId, null, "REVISION_EXHAUSTED");

  const beat = currentBeat(scenario, state);
  if (!beat) return blocked(optionId, null, "BEAT_NOT_AVAILABLE");
  const option = beat.options.find((candidate) => candidate.id === optionId);
  if (!option) return blocked(optionId, beat.id, "OPTION_NOT_AVAILABLE");

  const resolved = resolveOption(option, state);
  if (!resolved.ok) return blocked(option.id, beat.id, resolved.code);
  if (resolved.status === "blocked") return blocked(option.id, beat.id, "AUTHORED_BLOCKED");

  const applied = tryApplyEffectBatch(state, resolved.effects);
  if (!applied.ok) return blocked(option.id, beat.id, `EFFECT_${applied.code.toUpperCase()}`);
  const nextClock = state.clock.elapsedSeconds + option.clockAdvanceSeconds;
  if (!Number.isSafeInteger(nextClock)) return blocked(option.id, beat.id, "CLOCK_OVERFLOW");

  const candidateState: WorldState = deepFreeze({
    ...applied.state,
    revision: state.revision + 1,
    clock: { elapsedSeconds: nextClock },
    terminal: resolved.terminal ? { ...resolved.terminal } : state.terminal
  });

  return deepFreeze({
    committed: true as const,
    optionId: option.id,
    beatId: beat.id,
    status: resolved.status,
    durationSeconds: option.clockAdvanceSeconds,
    reasonCode: null,
    candidateState
  });
}

export function authoredScenarioPublicSituation(
  scenario: AuthoredScenarioSidecarData,
  state: WorldState
): JsonValue {
  const beat = currentBeat(scenario, state);
  return cloneJson({
    questId: scenario.questId,
    revision: state.revision,
    elapsedSeconds: state.clock.elapsedSeconds,
    beat: beat === null ? null : {
      id: beat.id,
      title: beat.title ?? null,
      options: beat.options.map((option) => ({
        id: option.id,
        status: resolvedOptionStatus(option, state),
        meaning: option.meaning ?? null
      }))
    }
  }) as JsonValue;
}

function resolvedOptionStatus(option: AuthoredScenarioOption, state: WorldState): AuthoredOptionStatus {
  const resolved = resolveOption(option, state);
  return resolved.ok ? resolved.status : "blocked";
}

function currentBeat(
  scenario: AuthoredScenarioSidecarData,
  state: WorldState
): AuthoredScenarioBeat | null {
  return scenario.beats[state.revision] ?? null;
}

function resolveOption(option: AuthoredScenarioOption, state: WorldState): ResolvedOption {
  for (const optionCase of option.cases ?? []) {
    const evaluated = evaluateCondition(state, optionCase.when);
    if (!evaluated.ok) return Object.freeze({ ok: false, code: `CASE_${evaluated.code.toUpperCase()}` });
    if (evaluated.value) {
      return Object.freeze({
        ok: true,
        status: optionCase.status,
        effects: optionCase.effects,
        terminal: optionCase.terminal ?? option.terminal ?? null
      });
    }
  }
  return Object.freeze({
    ok: true,
    status: option.status,
    effects: option.effects,
    terminal: option.terminal ?? null
  });
}

function blocked(optionId: string | null, beatId: string | null, reasonCode: string): AuthoredScenarioExecution {
  return Object.freeze({
    committed: false as const,
    optionId,
    beatId,
    status: "blocked" as const,
    durationSeconds: 0 as const,
    reasonCode,
    candidateState: null
  });
}

function extractBeats(value: unknown): unknown {
  if (isPlainObject(value) && Array.isArray(value.beats)) return value.beats;
  return value;
}

function normalizeScenario(value: unknown): AuthoredScenarioSidecarData | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ["format", "artifactHash", "questId", "initialState", "beats"])) return null;
  if (value.format !== AUTHORED_SCENARIO_FORMAT
    || typeof value.artifactHash !== "string" || !HASH.test(value.artifactHash)
    || typeof value.questId !== "string" || !ID.test(value.questId)
    || !Array.isArray(value.beats) || value.beats.length < 1 || value.beats.length > MAX_BEATS) return null;

  const state = cloneJson(value.initialState) as WorldState;
  if (tryApplyEffectBatch(state, []).ok !== true || state.revision !== 0 || state.terminal !== null) return null;

  const beatIds = new Set<string>();
  const optionIds = new Set<string>();
  const beats: AuthoredScenarioBeat[] = [];
  for (const rawBeat of value.beats) {
    if (!isPlainObject(rawBeat) || typeof rawBeat.id !== "string" || !ID.test(rawBeat.id)
      || beatIds.has(rawBeat.id) || !Array.isArray(rawBeat.options)
      || rawBeat.options.length < 1 || rawBeat.options.length > MAX_OPTIONS_PER_BEAT) return null;
    if (rawBeat.title !== undefined && (typeof rawBeat.title !== "string" || rawBeat.title.length > 500)) return null;
    beatIds.add(rawBeat.id);
    const options: AuthoredScenarioOption[] = [];
    for (const rawOption of rawBeat.options) {
      if (!isPlainObject(rawOption) || typeof rawOption.id !== "string" || !ID.test(rawOption.id)
        || optionIds.has(rawOption.id)
        || !isOptionStatus(rawOption.status)
        || !Number.isSafeInteger(rawOption.clockAdvanceSeconds) || Number(rawOption.clockAdvanceSeconds) < 0
        || Number(rawOption.clockAdvanceSeconds) > MAX_CLOCK_ADVANCE_SECONDS
        || !Array.isArray(rawOption.effects) || rawOption.effects.length > MAX_EFFECTS_PER_OPTION) return null;
      if (rawOption.meaning !== undefined && (typeof rawOption.meaning !== "string" || rawOption.meaning.length > 2_000)) return null;
      const terminal = normalizeTerminal(rawOption.terminal);
      if (rawOption.terminal !== undefined && terminal === null) return null;
      const cases = normalizeCases(rawOption.cases, state);
      if (rawOption.cases !== undefined && cases === null) return null;
      optionIds.add(rawOption.id);
      options.push(deepFreeze({
        id: rawOption.id,
        status: rawOption.status,
        clockAdvanceSeconds: Number(rawOption.clockAdvanceSeconds),
        effects: cloneJson(rawOption.effects),
        ...(terminal ? { terminal } : {}),
        ...(cases && cases.length > 0 ? { cases } : {}),
        ...(typeof rawOption.meaning === "string" ? { meaning: rawOption.meaning } : {})
      }));
    }
    beats.push(deepFreeze({
      id: rawBeat.id,
      ...(typeof rawBeat.title === "string" ? { title: rawBeat.title } : {}),
      options
    }));
  }

  return deepFreeze({
    format: AUTHORED_SCENARIO_FORMAT,
    artifactHash: value.artifactHash,
    questId: value.questId,
    initialState: state,
    beats
  });
}

function normalizeCases(value: unknown, state: WorldState): readonly AuthoredScenarioOptionCase[] | null {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CASES_PER_OPTION) return null;
  const cases: AuthoredScenarioOptionCase[] = [];
  for (const rawCase of value) {
    if (!isPlainObject(rawCase)
      || !hasExactKeys(rawCase, rawCase.terminal === undefined ? ["when", "status", "effects"] : ["when", "status", "effects", "terminal"])
      || !isOptionStatus(rawCase.status)
      || !Array.isArray(rawCase.effects) || rawCase.effects.length > MAX_EFFECTS_PER_OPTION) return null;
    const condition = cloneJson(rawCase.when) as Condition;
    if (!evaluateCondition(state, condition).ok) return null;
    const terminal = normalizeTerminal(rawCase.terminal);
    if (rawCase.terminal !== undefined && terminal === null) return null;
    if (rawCase.status === "blocked" && (rawCase.effects.length > 0 || terminal !== null)) return null;
    cases.push(deepFreeze({
      when: condition,
      status: rawCase.status,
      effects: cloneJson(rawCase.effects),
      ...(terminal ? { terminal } : {})
    }));
  }
  return deepFreeze(cases);
}

function normalizeTerminal(value: unknown): WorldTerminal | null {
  if (value === undefined) return null;
  if (!isPlainObject(value) || !hasExactKeys(value, ["reason", "outcome"])) return null;
  if (typeof value.reason !== "string" || value.reason.length < 1 || value.reason.length > 500
    || typeof value.outcome !== "string" || value.outcome.length < 1 || value.outcome.length > 2_000) return null;
  return deepFreeze({ reason: value.reason, outcome: value.outcome });
}

function isOptionStatus(value: unknown): value is AuthoredOptionStatus {
  return value === "executed" || value === "conditional" || value === "blocked";
}




function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}