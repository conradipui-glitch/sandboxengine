import type { JsonValue } from "@living-history/contracts";
import type { CompiledQuestArtifact } from "@living-history/core";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const HASH = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SIDECAR_KIND = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const MAX_RELEASE_JSON_CHARS = 4_000_000;
const MAX_SIDECAR_JSON_CHARS = 1_000_000;

export interface ControlAuthoredPluginSidecar {
  readonly kind: string;
  readonly data: JsonValue;
}

/**
 * Immutable authoring/publication envelope around one final compiled artifact.
 * The inner QuestRelease.releaseId MUST equal this record's releaseId.
 */
export interface ControlReleaseRecord {
  readonly releaseId: string;
  readonly projectId: string;
  readonly questId: string;
  readonly draftRevision: number;
  readonly draftContentHash: string;
  readonly validationId: string;
  readonly validationCompiledContentHash: string;
  readonly compiledArtifact: CompiledQuestArtifact;
  readonly compiledContentHash: string;
  readonly contentHashAlgorithm: "sha256";
  readonly pluginRequirementsSidecar: JsonValue;
  readonly authoredPluginSidecars: readonly ControlAuthoredPluginSidecar[];
}

export type ControlPublicationEventKind = "publish" | "rollback";

export interface ControlPublicationEvent {
  readonly eventSequence: number;
  readonly projectId: string;
  readonly questId: string;
  readonly kind: ControlPublicationEventKind;
  readonly fromReleaseId: string | null;
  readonly toReleaseId: string;
  readonly actorUserId: string;
  readonly createdAtMs: number;
}

export type CreateStoredReleaseResult =
  | { readonly kind: "created"; readonly release: ControlReleaseRecord }
  | { readonly kind: "replay"; readonly release: ControlReleaseRecord }
  | { readonly kind: "release_exists" }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "invalid_request" };

export type PublishStoredReleaseResult =
  | { readonly kind: "published"; readonly currentReleaseId: string; readonly event: ControlPublicationEvent }
  | { readonly kind: "unchanged"; readonly currentReleaseId: string }
  | {
      readonly kind: "replay";
      readonly outcome: "published" | "unchanged";
      readonly currentReleaseId: string;
      readonly event: ControlPublicationEvent | null;
    }
  | { readonly kind: "release_not_found" }
  | { readonly kind: "current_release_conflict"; readonly currentReleaseId: string | null }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "invalid_request" };

export type RollbackStoredReleaseResult =
  | { readonly kind: "rolled_back"; readonly currentReleaseId: string; readonly event: ControlPublicationEvent }
  | { readonly kind: "unchanged"; readonly currentReleaseId: string }
  | {
      readonly kind: "replay";
      readonly outcome: "rolled_back" | "unchanged";
      readonly currentReleaseId: string;
      readonly event: ControlPublicationEvent | null;
    }
  | { readonly kind: "release_not_found" }
  | { readonly kind: "target_not_previously_published" }
  | { readonly kind: "current_release_conflict"; readonly currentReleaseId: string | null }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "invalid_request" };

export interface ControlReleaseStore {
  createRelease(input: {
    readonly release: ControlReleaseRecord;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<CreateStoredReleaseResult>;

  getRelease(projectId: string, questId: string, releaseId: string): Promise<ControlReleaseRecord | null>;
  listReleases(projectId: string, questId: string): Promise<readonly ControlReleaseRecord[]>;
  getCurrentReleaseId(projectId: string, questId: string): Promise<string | null>;
  listPublicationEvents(projectId: string, questId: string): Promise<readonly ControlPublicationEvent[]>;

  publishRelease(input: {
    readonly projectId: string;
    readonly questId: string;
    readonly releaseId: string;
    readonly expectedCurrentReleaseId: string | null;
    readonly actorUserId: string;
    readonly createdAtMs: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<PublishStoredReleaseResult>;

  rollbackRelease(input: {
    readonly projectId: string;
    readonly questId: string;
    readonly targetReleaseId: string;
    readonly expectedCurrentReleaseId: string;
    readonly actorUserId: string;
    readonly createdAtMs: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<RollbackStoredReleaseResult>;
}

export function isControlReleaseRecord(value: unknown): value is ControlReleaseRecord {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    "releaseId", "projectId", "questId", "draftRevision", "draftContentHash", "validationId",
    "validationCompiledContentHash", "compiledArtifact", "compiledContentHash", "contentHashAlgorithm",
    "pluginRequirementsSidecar", "authoredPluginSidecars"
  ])) return false;
  if (!isControlReleaseId(value.releaseId) || !isControlReleaseId(value.projectId) || !isControlReleaseId(value.questId)
    || !isNonNegativeSafeInteger(value.draftRevision) || !isControlReleaseHash(value.draftContentHash)
    || !isControlReleaseId(value.validationId) || !isControlReleaseHash(value.validationCompiledContentHash)
    || !isControlReleaseHash(value.compiledContentHash) || value.contentHashAlgorithm !== "sha256") return false;
  if (!isCompiledArtifactEnvelope(value.compiledArtifact, value.questId, value.releaseId)) return false;
  if (!isBoundedJsonValue(value.pluginRequirementsSidecar, MAX_SIDECAR_JSON_CHARS)) return false;
  if (!Array.isArray(value.authoredPluginSidecars) || value.authoredPluginSidecars.length > 64) return false;
  const kinds = new Set<string>();
  for (const sidecar of value.authoredPluginSidecars) {
    if (!isPlainObject(sidecar) || !hasExactKeys(sidecar, ["kind", "data"])
      || typeof sidecar.kind !== "string" || !SIDECAR_KIND.test(sidecar.kind)
      || kinds.has(sidecar.kind) || !isBoundedJsonValue(sidecar.data, MAX_SIDECAR_JSON_CHARS)) return false;
    kinds.add(sidecar.kind);
  }
  return jsonLengthWithin(value.compiledArtifact, MAX_RELEASE_JSON_CHARS);
}

export function isControlReleaseId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

export function isControlReleaseHash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

export function isReleaseIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY.test(value);
}

export function isReleaseTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function cloneAndFreezeRelease<T>(value: T): T {
  return deepFreeze(JSON.parse(JSON.stringify(value)) as T);
}

function isCompiledArtifactEnvelope(value: unknown, questId: string, releaseId: string): value is CompiledQuestArtifact {
  if (!isPlainObject(value) || !hasExactKeys(value, ["release", "blocks"])) return false;
  if (!isPlainObject(value.release) || !Array.isArray(value.blocks) || value.blocks.length < 1 || value.blocks.length > 1_000) return false;
  return value.release.questId === questId && value.release.releaseId === releaseId;
}

function isBoundedJsonValue(value: unknown, maxChars: number): value is JsonValue {
  return isJsonValue(value, 0) && jsonLengthWithin(value, maxChars);
}

function isJsonValue(value: unknown, depth: number): value is JsonValue {
  if (depth > 16) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1_024 && value.every((child) => isJsonValue(child, depth + 1));
  if (!isPlainObject(value) || Object.keys(value).length > 1_024) return false;
  return Object.values(value).every((child) => isJsonValue(child, depth + 1));
}

function jsonLengthWithin(value: unknown, maxChars: number): boolean {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" && encoded.length <= maxChars;
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
