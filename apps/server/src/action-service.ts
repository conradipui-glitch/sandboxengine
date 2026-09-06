// @ts-ignore — runtime is pinned to Node 24.19.0; no @types/node dependency is installed yet.
import { createHash } from "node:crypto";
import {
  CONTRACT_SCHEMA_VERSION,
  type JsonValue,
  type ResolvedIntent,
  type WorldState
} from "@living-history/contracts";
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
}

const PAINT_DEFINITION: PaintActionDefinition = Object.freeze({
  id: "runtime.paint",
  actionType: "core.paint",
  resourceId: "blue_paint",
  resourceUnitsPerUnit: 1,
  durationSecondsPerUnit: 300,
  allowPartial: true
});

export function createCoreExplicitActionExecutor(): ExplicitActionExecutor {
  return Object.freeze({
    execute(state: WorldState, command: ExplicitActionCommand): ExplicitActionExecution {
      if (command.type !== "core.paint") throw new TypeError("unsupported explicit action");
      const intent: ResolvedIntent = Object.freeze({
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

      const resolved = resolvePaintAction(state, PAINT_DEFINITION, intent);
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
  });
}

export function buildCommittedPublicResponse(input: {
  readonly operationId: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly release: PinnedReleaseIdentity;
  readonly execution: ExplicitActionExecution;
}): RuntimePublicResponse {
  const playerView: PlayerView = projectPlayerState(
    input.sessionId,
    input.release.questId,
    input.release.releaseId,
    input.execution.candidateState
  );
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
