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

type LooseRecord = Readonly<Record<string, unknown>>;

/**
 * Deny-by-default player projection for the current bounded WorldState.
 * Every exposed field is copied explicitly. Never widen this into `state` passthrough.
 *
 * The projection is total: a legacy or corrupted persisted state (for example one
 * written before `terminal` became a required nullable key) degrades to an empty
 * projection instead of throwing `TypeError` on a missing piece. New writes are
 * guarded by isValidWorldState, so this path only covers state already on disk.
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
  const source = asRecord(state);
  const clock = asRecord(source.clock);
  return deepFreeze({
    sessionId,
    release: { questId, releaseId },
    revision: asSafeInteger(source.revision),
    clock: { elapsedSeconds: asSafeInteger(clock.elapsedSeconds) },
    entities: asRecords(source.entities).map((entity) => ({
      id: asText(entity.id),
      status: asText(entity.status),
      locationId: typeof entity.locationId === "string" ? entity.locationId : null
    })),
    resources: asRecords(source.resources).map((resource) => ({
      id: asText(resource.id),
      unit: asText(resource.unit),
      value: asSafeInteger(resource.value)
    })),
    items: asRecords(source.items).map((item) => {
      const position = asRecord(item.position);
      return position.kind === "location"
        ? { id: asText(item.id), position: { kind: "location" as const, locationId: asText(position.locationId) } }
        : { id: asText(item.id), position: { kind: "holder" as const, holderId: asText(position.holderId) } };
    }),
    terminal: normalizeTerminal(source.terminal)
  });
}

/** A terminal is either a well-formed `{ reason, outcome }` or `null`; anything else is "not ended". */
function normalizeTerminal(value: unknown): PlayerTerminalView | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.reason !== "string" || typeof value.outcome !== "string") return null;
  return { reason: value.reason, outcome: value.outcome };
}

function asRecord(value: unknown): LooseRecord {
  return isPlainObject(value) ? value : {};
}

function asRecords(value: unknown): readonly LooseRecord[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asSafeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function isPlainObject(value: unknown): value is LooseRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
