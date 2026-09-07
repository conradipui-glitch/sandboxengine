import {
  buildPluginRegistry,
  checkPluginRequirements,
  type PluginCompatibilityIssue,
  type PluginRegistrySnapshot,
  type PluginReleaseRequirements
} from "./index.js";

export const PLUGIN_ARTIFACT_REQUIREMENTS_SCHEMA_VERSION = "1.0" as const;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface PluginArtifactRequirementsSidecar {
  readonly schemaVersion: typeof PLUGIN_ARTIFACT_REQUIREMENTS_SCHEMA_VERSION;
  readonly artifactHash: string;
  readonly requirements: PluginReleaseRequirements;
}

export type PluginArtifactPreflightResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "INVALID_SIDECAR" | "ARTIFACT_HASH_MISMATCH" | "PLUGIN_REQUIREMENTS_UNMET";
      readonly issues?: readonly PluginCompatibilityIssue[];
    };

export function createPluginArtifactRequirementsSidecar(
  artifactHash: string,
  requirements: PluginReleaseRequirements
): PluginArtifactRequirementsSidecar | null {
  if (!SHA256_HEX.test(artifactHash)) return null;
  const empty = buildPluginRegistry([]);
  if (!empty.ok) return null;
  const validation = checkPluginRequirements(empty.registry, requirements);
  if (!validation.compatible && validation.issues.some((issue) => issue.code === "INVALID_REQUIREMENTS")) {
    return null;
  }
  return deepFreeze({
    schemaVersion: PLUGIN_ARTIFACT_REQUIREMENTS_SCHEMA_VERSION,
    artifactHash,
    requirements: cloneJson(requirements)
  });
}

/**
 * Generic immutable-artifact start/publish preflight. The caller must provide
 * the exact compiled/frozen content hash it is about to start or publish.
 */
export function preflightPluginArtifactRequirements(
  registry: PluginRegistrySnapshot,
  sidecar: unknown,
  actualArtifactHash: string
): PluginArtifactPreflightResult {
  if (!SHA256_HEX.test(actualArtifactHash) || !isSidecarShape(sidecar)) {
    return Object.freeze({ ok: false, code: "INVALID_SIDECAR" });
  }
  if (sidecar.artifactHash !== actualArtifactHash) {
    return Object.freeze({ ok: false, code: "ARTIFACT_HASH_MISMATCH" });
  }
  const compatibility = checkPluginRequirements(registry, sidecar.requirements);
  if (!compatibility.compatible) {
    return Object.freeze({
      ok: false,
      code: "PLUGIN_REQUIREMENTS_UNMET",
      issues: Object.freeze([...compatibility.issues])
    });
  }
  return Object.freeze({ ok: true });
}

function isSidecarShape(value: unknown): value is PluginArtifactRequirementsSidecar {
  if (!isPlainObject(value) || !hasExactKeys(value, ["schemaVersion", "artifactHash", "requirements"])) return false;
  if (value.schemaVersion !== PLUGIN_ARTIFACT_REQUIREMENTS_SCHEMA_VERSION
    || typeof value.artifactHash !== "string"
    || !SHA256_HEX.test(value.artifactHash)
    || !isPlainObject(value.requirements)) return false;

  const empty = buildPluginRegistry([]);
  if (!empty.ok) return false;
  const validation = checkPluginRequirements(
    empty.registry,
    value.requirements as unknown as PluginReleaseRequirements
  );
  return validation.compatible || !validation.issues.some((issue) => issue.code === "INVALID_REQUIREMENTS");
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
