import type { ActionStatus } from "./status.js";

/** A reference to one validated effect, not an instruction to mutate state. */
export interface EffectRef {
  readonly type: string;
  readonly sourceId: string;
}

/** Minimal result envelope shared by Core and all future adapters. */
export interface ActionResultEnvelope {
  readonly status: ActionStatus;
  readonly durationSeconds: number;
  readonly effects: readonly EffectRef[];
}

export function isEffectRef(value: unknown): value is EffectRef {
  if (!isRecord(value)) return false;
  return typeof value.type === "string" && value.type.length > 0
    && typeof value.sourceId === "string" && value.sourceId.length > 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

