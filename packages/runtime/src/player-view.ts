import type { WorldState } from "@living-history/contracts";
import type { SessionRecord } from "./storage.js";

export interface PlayerReleaseView {
  readonly questId: string;
  readonly releaseId: string;
}

export interface PlayerClockView {
  readonly elapsedSeconds: number;
}

export interface PlayerEntityView {
  readonly id: string;
  readonly status: string;
  readonly locationId: string | null;
}

export interface PlayerResourceView {
  readonly id: string;
  readonly unit: string;
  readonly value: number;
}

export interface PlayerItemView {
  readonly id: string;
  readonly position:
    | { readonly kind: "location"; readonly locationId: string }
    | { readonly kind: "holder"; readonly holderId: string };
}

export interface PlayerTerminalView {
  readonly reason: string;
  readonly outcome: string;
}

export interface PlayerView {
  readonly sessionId: string;
  readonly release: PlayerReleaseView;
  readonly revision: number;
  readonly clock: PlayerClockView;
  readonly entities: readonly PlayerEntityView[];
  readonly resources: readonly PlayerResourceView[];
  readonly items: readonly PlayerItemView[];
  readonly terminal: PlayerTerminalView | null;
}

/**
 * Deny-by-default player projection for the current bounded WorldState.
 * Every exposed field is copied explicitly. Never widen this into `state` passthrough.
 */
export function projectPlayerView(session: SessionRecord): PlayerView {
  return projectPlayerState(session.sessionId, session.release.questId, session.release.releaseId, session.state);
}

export function projectPlayerState(
  sessionId: string,
  questId: string,
  releaseId: string,
  state: WorldState
): PlayerView {
  return deepFreeze({
    sessionId,
    release: { questId, releaseId },
    revision: state.revision,
    clock: { elapsedSeconds: state.clock.elapsedSeconds },
    entities: state.entities.map((entity) => ({
      id: entity.id,
      status: entity.status,
      locationId: entity.locationId
    })),
    resources: state.resources.map((resource) => ({
      id: resource.id,
      unit: resource.unit,
      value: resource.value
    })),
    items: state.items.map((item) => ({
      id: item.id,
      position: item.position.kind === "location"
        ? { kind: "location" as const, locationId: item.position.locationId }
        : { kind: "holder" as const, holderId: item.position.holderId }
    })),
    terminal: state.terminal === null
      ? null
      : { reason: state.terminal.reason, outcome: state.terminal.outcome }
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
