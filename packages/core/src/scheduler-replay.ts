import type {
  GameplayEffect,
  WorldState
} from "@living-history/contracts";
import { canonicalStringify } from "./compile.js";
import type { DeterministicRngProvenance } from "./rng.js";
import type { ProcessedSchedulerEvent } from "./scheduler-process.js";
import type { TimeAdvancePlanSuccess } from "./scheduler.js";

export interface SchedulerReplayVersions {
  readonly engineVersion: string;
  readonly contractsSchemaVersion: string;
}

export interface SchedulerReplayFingerprintInput {
  readonly versions: SchedulerReplayVersions;
  readonly initialState: WorldState;
  readonly plan: TimeAdvancePlanSuccess;
  readonly rngProvenance: readonly DeterministicRngProvenance[];
  readonly processedEvents: readonly ProcessedSchedulerEvent[];
  readonly finalState: WorldState;
}

export interface SchedulerReplayFingerprint {
  readonly canonicalJson: string;
  readonly hash: string;
  readonly hashAlgorithm: "sha256";
  readonly orderedEffects: readonly GameplayEffect[];
}

/**
 * Deterministic replay fingerprint for B03/B04 handoff. It intentionally reuses
 * the project's canonicalStringify instead of introducing another serializer.
 */
export async function buildSchedulerReplayFingerprint(
  input: SchedulerReplayFingerprintInput
): Promise<SchedulerReplayFingerprint> {
  const orderedEffects = input.processedEvents.flatMap(({ event }) =>
    event.kind === "core.effects" ? [...event.payload.effects] : []
  );
  const payload = {
    versions: input.versions,
    initialState: input.initialState,
    plan: input.plan,
    rngProvenance: input.rngProvenance,
    processedEvents: input.processedEvents,
    orderedEffects,
    finalState: input.finalState
  };
  const canonicalJson = canonicalStringify(payload);
  const hash = await sha256Hex(canonicalJson);
  return Object.freeze({
    canonicalJson,
    hash,
    hashAlgorithm: "sha256" as const,
    orderedEffects: Object.freeze(orderedEffects.map(freezeEffect))
  });
}

function freezeEffect(effect: GameplayEffect): GameplayEffect {
  if (effect.type === "item.transfer") {
    return Object.freeze({
      ...effect,
      destination: Object.freeze({ ...effect.destination })
    });
  }
  return Object.freeze({ ...effect });
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
