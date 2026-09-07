import type { TrustedPluginBackendRegistration } from "./execution.js";
import {
  createDiceCheckRegistration,
  validateDiceCheckDefinition,
  type DiceCheckDefinition
} from "./dice-check.js";

export const DICE_CHECK_AUTHORED_SIDECAR_SCHEMA_VERSION = "1.0" as const;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Immutable authored dice-check data for one exact compiled/frozen artifact.
 * The core QuestRelease/FrozenPlaytest v1 contracts remain unchanged; callers
 * persist this sidecar beside the frozen artifact and must supply the exact
 * artifact hash again when creating executable registrations.
 */
export interface DiceCheckAuthoredSidecar {
  readonly schemaVersion: typeof DICE_CHECK_AUTHORED_SIDECAR_SCHEMA_VERSION;
  readonly artifactHash: string;
  readonly definitions: readonly DiceCheckDefinition[];
}

export type DiceCheckArtifactBindingResult =
  | {
      readonly ok: true;
      readonly registration: TrustedPluginBackendRegistration;
    }
  | {
      readonly ok: false;
      readonly code: "INVALID_DICE_CHECK_SIDECAR" | "ARTIFACT_HASH_MISMATCH";
    };

export function createDiceCheckAuthoredSidecar(
  artifactHash: string,
  definitions: readonly DiceCheckDefinition[]
): DiceCheckAuthoredSidecar | null {
  if (!SHA256_HEX.test(artifactHash) || !hasValidDefinitions(definitions)) return null;
  return deepFreeze({
    schemaVersion: DICE_CHECK_AUTHORED_SIDECAR_SCHEMA_VERSION,
    artifactHash,
    definitions: cloneJson(definitions)
  });
}

/**
 * Frozen-artifact registration gate. The registration is materialized only
 * after the sidecar shape and exact compiled/frozen artifact hash match.
 * Definitions are validated again and cloned by createDiceCheckRegistration,
 * so later caller mutation cannot alter the executable authored mechanic.
 */
export function bindDiceCheckRegistrationToArtifact(
  sidecar: unknown,
  actualArtifactHash: string
): DiceCheckArtifactBindingResult {
  if (!SHA256_HEX.test(actualArtifactHash) || !isValidSidecar(sidecar)) {
    return Object.freeze({ ok: false, code: "INVALID_DICE_CHECK_SIDECAR" });
  }
  if (sidecar.artifactHash !== actualArtifactHash) {
    return Object.freeze({ ok: false, code: "ARTIFACT_HASH_MISMATCH" });
  }
  try {
    return Object.freeze({
      ok: true,
      registration: createDiceCheckRegistration(sidecar.definitions)
    });
  } catch {
    return Object.freeze({ ok: false, code: "INVALID_DICE_CHECK_SIDECAR" });
  }
}

export function isValidDiceCheckAuthoredSidecar(value: unknown): value is DiceCheckAuthoredSidecar {
  return isValidSidecar(value);
}

function isValidSidecar(value: unknown): value is DiceCheckAuthoredSidecar {
  if (!isPlainObject(value) || !hasExactKeys(value, ["schemaVersion", "artifactHash", "definitions"])) return false;
  return value.schemaVersion === DICE_CHECK_AUTHORED_SIDECAR_SCHEMA_VERSION
    && typeof value.artifactHash === "string"
    && SHA256_HEX.test(value.artifactHash)
    && hasValidDefinitions(value.definitions);
}

function hasValidDefinitions(value: unknown): value is readonly DiceCheckDefinition[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) return false;
  const ids = new Set<string>();
  for (const definition of value) {
    if (!validateDiceCheckDefinition(definition) || ids.has(definition.definitionId)) return false;
    ids.add(definition.definitionId);
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
