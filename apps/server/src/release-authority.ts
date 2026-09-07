// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
import { createHash } from "node:crypto";
import {
  CONTRACT_SCHEMA_VERSION,
  type JsonValue,
  type QuestRelease
} from "@living-history/contracts";
import {
  canonicalStringify,
  compileQuest
} from "@living-history/core";
import {
  isControlReleaseRecord,
  type ControlAuthoredPluginSidecar,
  type ControlReleaseRecord,
  type ControlReleaseStore,
  type ControlStore,
  type CreateStoredReleaseResult,
  type DraftSnapshot,
  type DraftValidationRecord
} from "@living-history/control";
import {
  type PluginRegistrySnapshot,
  type PluginReleaseRequirements
} from "@living-history/plugins";
import {
  createPluginArtifactRequirementsSidecar,
  preflightPluginArtifactRequirements,
  type PluginArtifactRequirementsSidecar
} from "@living-history/plugins/artifact-compatibility";
import {
  bindDiceCheckRegistrationToArtifact,
  createDiceCheckAuthoredSidecar
} from "@living-history/plugins/dice-check-artifact";
import {
  DICE_CHECK_PLUGIN_ID,
  diceCheckPluginRequirements,
  type DiceCheckDefinition
} from "@living-history/plugins/dice-check";

export const DICE_CHECK_AUTHORED_SIDECAR_KIND = "dice-check.authored" as const;

export interface BuildControlReleaseInput {
  readonly projectId: string;
  readonly questId: string;
  readonly releaseId: string;
  readonly draftRevision: number;
  readonly validationId: string;
  readonly idempotencyKey: string;
  readonly diceCheckDefinitions?: readonly DiceCheckDefinition[];
}

export type BuildControlReleaseResult =
  | { readonly kind: "created"; readonly release: ControlReleaseRecord }
  | { readonly kind: "replay"; readonly release: ControlReleaseRecord }
  | { readonly kind: "snapshot_not_found" }
  | { readonly kind: "validation_not_found" }
  | { readonly kind: "validation_not_valid" }
  | { readonly kind: "validation_snapshot_mismatch" }
  | { readonly kind: "validation_integrity_failed" }
  | { readonly kind: "release_compile_failed"; readonly errors: readonly string[] }
  | { readonly kind: "plugin_authoring_invalid" }
  | { readonly kind: "plugin_preflight_failed"; readonly code: string }
  | { readonly kind: "release_exists" }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "invalid_request" };

export type StoredReleasePreflightResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | "INVALID_RELEASE"
        | "ARTIFACT_HASH_MISMATCH"
        | "PLUGIN_REQUIREMENTS_UNMET"
        | "UNSUPPORTED_AUTHORED_SIDECAR"
        | "AUTHORED_PLUGIN_BINDING_FAILED"
        | "AUTHORED_PLUGIN_REQUIREMENT_MISSING";
    };

export interface ControlReleaseAuthorityDependencies {
  readonly controlStore: ControlStore;
  readonly releaseStore: ControlReleaseStore;
  readonly pluginRegistry: PluginRegistrySnapshot;
}

/**
 * Builds one immutable release only from an exact valid validation. The browser
 * never supplies a trusted artifact hash or pre-built plugin sidecar: both are
 * created from the validated snapshot by this server-side authority boundary.
 */
export async function buildControlRelease(
  deps: ControlReleaseAuthorityDependencies,
  input: BuildControlReleaseInput
): Promise<BuildControlReleaseResult> {
  if (!isBuildInput(input)) return frozen({ kind: "invalid_request" });

  const snapshot = await deps.controlStore.getDraftSnapshot(input.projectId, input.questId, input.draftRevision);
  if (!snapshot) return frozen({ kind: "snapshot_not_found" });
  const validation = await deps.controlStore.getValidation(input.validationId);
  if (!validation) return frozen({ kind: "validation_not_found" });
  if (validation.status !== "valid") return frozen({ kind: "validation_not_valid" });
  if (!validationMatchesSnapshot(validation, snapshot)) {
    return frozen({ kind: "validation_snapshot_mismatch" });
  }

  const validationHash = sha256Canonical(validation.compiledArtifact);
  if (validationHash !== validation.compiledContentHash) {
    return frozen({ kind: "validation_integrity_failed" });
  }

  const validationRecompile = await compileQuest(
    makeQuestRelease(snapshot, validation.compiledArtifact.release.releaseId),
    snapshot.blocks
  );
  if (!validationRecompile.ok || validationRecompile.contentHash !== validation.compiledContentHash) {
    return frozen({ kind: "validation_integrity_failed" });
  }

  const compiled = await compileQuest(makeQuestRelease(snapshot, input.releaseId), snapshot.blocks);
  if (!compiled.ok) {
    return frozen({ kind: "release_compile_failed", errors: Object.freeze([...compiled.errors]) });
  }

  const pluginBuild = buildReleasePluginSidecars(compiled.contentHash, input.diceCheckDefinitions);
  if (!pluginBuild.ok) return frozen({ kind: "plugin_authoring_invalid" });

  const requirementsPreflight = preflightPluginArtifactRequirements(
    deps.pluginRegistry,
    pluginBuild.requirementsSidecar,
    compiled.contentHash
  );
  if (!requirementsPreflight.ok) {
    return frozen({ kind: "plugin_preflight_failed", code: requirementsPreflight.code });
  }

  const release: ControlReleaseRecord = deepFreeze({
    releaseId: input.releaseId,
    projectId: input.projectId,
    questId: input.questId,
    draftRevision: input.draftRevision,
    draftContentHash: snapshot.contentHash,
    validationId: validation.validationId,
    validationCompiledContentHash: validation.compiledContentHash,
    compiledArtifact: compiled.artifact,
    compiledContentHash: compiled.contentHash,
    contentHashAlgorithm: "sha256" as const,
    pluginRequirementsSidecar: cloneJson(pluginBuild.requirementsSidecar) as unknown as JsonValue,
    authoredPluginSidecars: pluginBuild.authoredPluginSidecars
  });

  const finalPreflight = preflightStoredControlRelease(release, deps.pluginRegistry);
  if (!finalPreflight.ok) {
    return frozen({ kind: "plugin_preflight_failed", code: finalPreflight.code });
  }

  const requestHash = sha256Canonical({
    projectId: input.projectId,
    questId: input.questId,
    releaseId: input.releaseId,
    draftRevision: input.draftRevision,
    validationId: input.validationId,
    diceCheckDefinitions: input.diceCheckDefinitions ?? null
  });
  const stored = await deps.releaseStore.createRelease({
    release,
    idempotencyKey: input.idempotencyKey,
    requestHash
  });
  return mapStoredCreate(stored);
}

/**
 * One canonical integrity/compatibility gate reused by publish, rollback and
 * Runtime published-release resolution. It never repairs from the current draft
 * and never substitutes another plugin/release version.
 */
export function preflightStoredControlRelease(
  value: unknown,
  pluginRegistry: PluginRegistrySnapshot
): StoredReleasePreflightResult {
  if (!isControlReleaseRecord(value)) return frozen({ ok: false, code: "INVALID_RELEASE" });
  if (sha256Canonical(value.compiledArtifact) !== value.compiledContentHash) {
    return frozen({ ok: false, code: "ARTIFACT_HASH_MISMATCH" });
  }

  const requirements = value.pluginRequirementsSidecar as unknown as PluginArtifactRequirementsSidecar;
  const compatibility = preflightPluginArtifactRequirements(pluginRegistry, requirements, value.compiledContentHash);
  if (!compatibility.ok) return frozen({ ok: false, code: "PLUGIN_REQUIREMENTS_UNMET" });

  let hasDiceAuthored = false;
  for (const sidecar of value.authoredPluginSidecars) {
    if (sidecar.kind !== DICE_CHECK_AUTHORED_SIDECAR_KIND) {
      return frozen({ ok: false, code: "UNSUPPORTED_AUTHORED_SIDECAR" });
    }
    if (hasDiceAuthored) return frozen({ ok: false, code: "INVALID_RELEASE" });
    hasDiceAuthored = true;
    const bound = bindDiceCheckRegistrationToArtifact(sidecar.data, value.compiledContentHash);
    if (!bound.ok) return frozen({ ok: false, code: "AUTHORED_PLUGIN_BINDING_FAILED" });
  }

  if (hasDiceAuthored && !requirementsContainPlugin(requirements.requirements, DICE_CHECK_PLUGIN_ID)) {
    return frozen({ ok: false, code: "AUTHORED_PLUGIN_REQUIREMENT_MISSING" });
  }

  return frozen({ ok: true });
}

function buildReleasePluginSidecars(
  artifactHash: string,
  diceCheckDefinitions: readonly DiceCheckDefinition[] | undefined
):
  | {
      readonly ok: true;
      readonly requirementsSidecar: PluginArtifactRequirementsSidecar;
      readonly authoredPluginSidecars: readonly ControlAuthoredPluginSidecar[];
    }
  | { readonly ok: false } {
  const requirements: PluginReleaseRequirements = diceCheckDefinitions === undefined
    ? deepFreeze({ plugins: [] })
    : diceCheckPluginRequirements();
  const requirementsSidecar = createPluginArtifactRequirementsSidecar(artifactHash, requirements);
  if (!requirementsSidecar) return frozen({ ok: false });

  if (diceCheckDefinitions === undefined) {
    return deepFreeze({ ok: true, requirementsSidecar, authoredPluginSidecars: [] });
  }
  const authored = createDiceCheckAuthoredSidecar(artifactHash, diceCheckDefinitions);
  if (!authored) return frozen({ ok: false });
  const bound = bindDiceCheckRegistrationToArtifact(authored, artifactHash);
  if (!bound.ok) return frozen({ ok: false });
  return deepFreeze({
    ok: true,
    requirementsSidecar,
    authoredPluginSidecars: [{
      kind: DICE_CHECK_AUTHORED_SIDECAR_KIND,
      data: cloneJson(authored) as unknown as JsonValue
    }]
  });
}

function validationMatchesSnapshot(validation: DraftValidationRecord, snapshot: DraftSnapshot): boolean {
  return validation.projectId === snapshot.projectId
    && validation.questId === snapshot.questId
    && validation.draftRevision === snapshot.draftRevision
    && validation.contentHash === snapshot.contentHash;
}

function makeQuestRelease(snapshot: DraftSnapshot, releaseId: string): QuestRelease {
  return deepFreeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    questId: snapshot.questId,
    releaseId,
    title: snapshot.title,
    compatibility: { contractsSchemaVersion: CONTRACT_SCHEMA_VERSION },
    blockIds: snapshot.blocks.map((block) => block.id),
    entryLocationId: snapshot.entryLocationId
  });
}

function requirementsContainPlugin(requirements: PluginReleaseRequirements, pluginId: string): boolean {
  return Array.isArray(requirements.plugins) && requirements.plugins.some((entry) => entry.pluginId === pluginId);
}

function mapStoredCreate(result: CreateStoredReleaseResult): BuildControlReleaseResult {
  if (result.kind === "created" || result.kind === "replay") return result;
  if (result.kind === "release_exists") return frozen({ kind: "release_exists" });
  if (result.kind === "idempotency_key_reused") return frozen({ kind: "idempotency_key_reused" });
  return frozen({ kind: "invalid_request" });
}

function isBuildInput(value: unknown): value is BuildControlReleaseInput {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = ["draftRevision", "idempotencyKey", "projectId", "questId", "releaseId", "validationId"];
  if (value.diceCheckDefinitions !== undefined) expected.push("diceCheckDefinitions");
  expected.sort();
  if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) return false;
  return isId(value.projectId)
    && isId(value.questId)
    && isId(value.releaseId)
    && isId(value.validationId)
    && isId(value.idempotencyKey)
    && typeof value.draftRevision === "number"
    && Number.isSafeInteger(value.draftRevision)
    && value.draftRevision >= 0
    && (value.diceCheckDefinitions === undefined || Array.isArray(value.diceCheckDefinitions));
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function frozen<const T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
