import { CONTRACT_SCHEMA_VERSION, type ContractSchemaVersion } from "./schema.js";
import { isActionStatus, type ActionStatus } from "./status.js";

/**
 * Minimal effect envelope mirrored from schemas/v1/effect.schema.json.
 * B02 will add typed effect payloads; unknown payload fields are not accepted in
 * this first contract version.
 */
export interface Effect {
  readonly schemaVersion: ContractSchemaVersion;
  readonly type: string;
  readonly sourceId: string;
}

/** Compatibility name kept for the B01-01 public export. */
export type EffectRef = Effect;

/**
 * Minimal calculated game result mirrored from
 * schemas/v1/action-result.schema.json.
 */
export interface ActionResultEnvelope {
  readonly schemaVersion: ContractSchemaVersion;
  readonly status: ActionStatus;
  readonly durationSeconds: number;
  readonly effects: readonly Effect[];
}

export type ActionResult = ActionResultEnvelope;

/**
 * Public boundary guard. It checks the transport shape only; Core decides
 * whether a valid effect batch may be applied to a particular world state.
 * JSON Schema remains authoritative; schema tests keep this guard in lockstep.
 */
export function isActionResultEnvelope(value: unknown): value is ActionResultEnvelope {
  if (!isRecord(value) || !hasOnlyKeys(value, ["schemaVersion", "status", "durationSeconds", "effects"])) return false;
  if (value.schemaVersion !== CONTRACT_SCHEMA_VERSION || !isActionStatus(value.status)) return false;
  if (typeof value.durationSeconds !== "number"
    || !Number.isInteger(value.durationSeconds)
    || value.durationSeconds < 0) return false;
  return Array.isArray(value.effects) && value.effects.every(isEffect);
}

export const isActionResult = isActionResultEnvelope;

export function isEffect(value: unknown): value is Effect {
  if (!isRecord(value) || !hasOnlyKeys(value, ["schemaVersion", "type", "sourceId"])) return false;
  return value.schemaVersion === CONTRACT_SCHEMA_VERSION
    && typeof value.type === "string"
    && /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(value.type)
    && typeof value.sourceId === "string"
    && value.sourceId.length > 0
    && value.sourceId.length <= 200;
}

export const isEffectRef = isEffect;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}
