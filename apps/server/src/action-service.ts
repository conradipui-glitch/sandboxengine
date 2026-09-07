// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { createHash } from "node:crypto";
import {
  CONTRACT_SCHEMA_VERSION,
  type JsonValue,
  type ResolvedIntent,
  type WorldState
} from "@living-history/contracts";
import type {
  FactPacket,
  IntentActionCatalogEntry,
  NarrativeResult
} from "@living-history/ai";
import {
  applyTimeAdvancePlan,
  canonicalStringify,
  planTimeAdvance,
  resolvePaintAction,
  type PaintActionDefinition
} from "@living-history/core";
import {
  projectPlayerState,
  type PlayerView,
  type PinnedReleaseIdentity,
  type RuntimePublicResponse
} from "@living-history/runtime";

export interface ExplicitPaintCommand {
  readonly type: "core.paint";
  readonly units: number;
}

export type ExplicitActionCommand = ExplicitPaintCommand;

export interface ExplicitActionExecution {
  readonly candidateState: WorldState;
  readonly actionStatus: "executed" | "partial" | "blocked";
  readonly requestedUnits: number;
  readonly completedUnits: number;
  readonly durationSeconds: number;
  readonly reasonCode: string | null;
}

export interface ExplicitActionExecutor {
  execute(state: WorldState, command: ExplicitActionCommand): ExplicitActionExecution;
  executeIntent(state: WorldState, intent: ResolvedIntent): ExplicitActionExecution;
}

const B04_COMPATIBILITY_PAINT_DEFINITION: PaintActionDefinition = Object.freeze({
  id: "runtime.paint",
  actionType: "core.paint",
  resourceId: "blue_paint",
  resourceUnitsPerUnit: 1,
  durationSecondsPerUnit: 300,
  allowPartial: true
});

/** B04 compatibility factory used by the published minimal Runtime template. */
export function createCoreExplicitActionExecutor(): ExplicitActionExecutor {
  return createCoreExplicitActionExecutorForDefinition(B04_COMPATIBILITY_PAINT_DEFINITION);
}

/** B05+ executor bound to one frozen authored action definition. */
export function createCoreExplicitActionExecutorForDefinition(
  definition: PaintActionDefinition
): ExplicitActionExecutor {
  const frozenDefinition: PaintActionDefinition = Object.freeze({ ...definition });
  return Object.freeze({
    execute(state: WorldState, command: ExplicitActionCommand): ExplicitActionExecution {
      return executePaintResolvedIntent(state, frozenDefinition, explicitCommandToResolvedIntent(command));
    },
    executeIntent(state: WorldState, intent: ResolvedIntent): ExplicitActionExecution {
      return executePaintResolvedIntent(state, frozenDefinition, intent);
    }
  });
}

/**
 * Both button/explicit input and validated free text terminate here. Natural
 * language never gets a second calculation path: Core owns resource/time/effect
 * semantics through resolvePaintAction.
 */
export function executePaintResolvedIntent(
  state: WorldState,
  definition: PaintActionDefinition,
  intent: ResolvedIntent
): ExplicitActionExecution {
  const resolved = resolvePaintAction(state, definition, intent);
  if (!resolved.ok) throw new Error(`core action resolution failed: ${resolved.code}`);
  const plan = planTimeAdvance(resolved.state, resolved.action.durationSeconds, []);
  if (!plan.ok) throw new Error(`time planning failed: ${plan.code}`);
  const advanced = applyTimeAdvancePlan(resolved.state, plan);
  if (!advanced.ok) throw new Error(`time application failed: ${advanced.code}`);

  return Object.freeze({
    candidateState: advanced.state,
    actionStatus: resolved.action.status,
    requestedUnits: resolved.action.requestedUnits,
    completedUnits: resolved.action.completedUnits,
    durationSeconds: resolved.action.durationSeconds,
    reasonCode: resolved.action.reasonCode
  });
}

export function explicitCommandToResolvedIntent(command: ExplicitActionCommand): ResolvedIntent {
  if (command.type !== "core.paint") throw new TypeError("unsupported explicit action");
  return Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    actionType: "core.paint",
    participantIds: Object.freeze([]),
    targetIds: Object.freeze([]),
    args: Object.freeze({ units: command.units }),
    sourceInput: Object.freeze({
      kind: "action",
      actionType: "core.paint",
      args: Object.freeze({ units: command.units })
    })
  });
}

export function createPaintIntentCatalog(
  maximumUnits = 1_000
): readonly IntentActionCatalogEntry[] {
  if (!Number.isSafeInteger(maximumUnits) || maximumUnits < 1 || maximumUnits > 1_000_000) {
    throw new RangeError("maximumUnits outside supported intent bounds");
  }
  return Object.freeze([
    Object.freeze({
      actionType: "core.paint",
      args: Object.freeze({
        units: Object.freeze({ type: "integer" as const, minimum: 1, maximum: maximumUnits })
      }),
      participantIds: Object.freeze([]),
      targetIds: Object.freeze([])
    })
  ]);
}

/**
 * Narrator input is derived only after Core has calculated the action.
 * It is intentionally smaller than WorldState and contains no executable effects,
 * draft data, hidden fields, min/max bounds, schedules or mutation instructions.
 */
export function buildFactPacket(input: {
  readonly beforeState: WorldState;
  readonly execution: ExplicitActionExecution;
}): FactPacket {
  const beforeResources = new Map(input.beforeState.resources.map((resource) => [resource.id, resource]));
  const changedResources = input.execution.candidateState.resources
    .filter((after) => beforeResources.get(after.id)?.value !== after.value)
    .slice(0, 100)
    .map((after) => {
      const before = beforeResources.get(after.id);
      if (!before) throw new Error(`candidate resource missing from before state: ${after.id}`);
      return Object.freeze({
        id: after.id,
        unit: after.unit,
        before: before.value,
        after: after.value
      });
    });

  return Object.freeze({
    schemaVersion: "1.0" as const,
    action: Object.freeze({
      type: "core.paint",
      status: input.execution.actionStatus,
      requestedUnits: input.execution.requestedUnits,
      completedUnits: input.execution.completedUnits,
      durationSeconds: input.execution.durationSeconds,
      reasonCode: input.execution.reasonCode
    }),
    clock: Object.freeze({
      beforeElapsedSeconds: input.beforeState.clock.elapsedSeconds,
      afterElapsedSeconds: input.execution.candidateState.clock.elapsedSeconds
    }),
    resources: Object.freeze(changedResources),
    allowedSpeakerIds: Object.freeze(
      input.execution.candidateState.entities.slice(0, 100).map((entity) => entity.id)
    ),
    observations: Object.freeze([])
  });
}

export function buildCommittedPublicResponse(input: {
  readonly operationId: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly release: PinnedReleaseIdentity;
  readonly execution: ExplicitActionExecution;
  readonly narrative?: NarrativeResult | null;
}): RuntimePublicResponse {
  const playerView: PlayerView = projectPlayerState(
    input.sessionId,
    input.release.questId,
    input.release.releaseId,
    input.execution.candidateState
  );
  const narrative = input.narrative
    ? Object.freeze({
        profile: input.narrative.profile,
        source: input.narrative.source,
        summary: input.narrative.content.summary,
        dialogue: input.narrative.content.dialogue.map((line) => Object.freeze({ ...line })),
        observationRefs: Object.freeze([...input.narrative.content.observationRefs])
      })
    : null;
  return deepFreeze({
    kind: "action_result",
    operationId: input.operationId,
    turnId: input.turnId,
    action: {
      type: "core.paint",
      status: input.execution.actionStatus,
      requestedUnits: input.execution.requestedUnits,
      completedUnits: input.execution.completedUnits,
      durationSeconds: input.execution.durationSeconds,
      reasonCode: input.execution.reasonCode
    },
    ...(narrative ? { narrative } : {}),
    playerView: toJsonValue(playerView)
  });
}

export function buildFailedPublicResponse(operationId: string): RuntimePublicResponse {
  return Object.freeze({
    kind: "failed",
    operationId,
    code: "ACTION_EXECUTION_FAILED"
  });
}

export function hashCanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}

export function stateHash(state: WorldState): string {
  return hashCanonicalJson(state);
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
