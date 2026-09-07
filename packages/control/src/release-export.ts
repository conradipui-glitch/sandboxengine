// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
import { createHash } from "node:crypto";
import { CONTRACT_SCHEMA_VERSION } from "@living-history/contracts";
import { canonicalStringify } from "@living-history/core";
import { isControlReleaseRecord, type ControlReleaseStore } from "./releases.js";
import { LHQUEST_FORMAT_VERSION, LHQUEST_MEDIA_TYPE } from "./quest-export.js";
import { writeStoredZip } from "./zip-store.js";

export interface LhquestReleaseManifest {
  readonly format: "living-history.lhquest";
  readonly formatVersion: typeof LHQUEST_FORMAT_VERSION;
  readonly source: {
    readonly kind: "release";
    readonly questId: string;
    readonly releaseId: string;
    readonly draftRevision: number;
    readonly draftContentHash: string;
    readonly compiledContentHash: string;
  };
  readonly compatibility: {
    readonly contractsSchemaVersion: typeof CONTRACT_SCHEMA_VERSION;
    readonly requiredPlugins: readonly [];
  };
  readonly integrity: {
    readonly algorithm: "sha256";
    readonly checksumFile: "SHA256SUMS";
    readonly coveredFiles: readonly ["manifest.json", "quest.json"];
  };
  readonly files: readonly [{
    readonly path: "quest.json";
    readonly mediaType: "application/json";
    readonly byteLength: number;
    readonly sha256: string;
  }];
}

export interface ReleaseQuestExport {
  readonly filename: string;
  readonly mediaType: typeof LHQUEST_MEDIA_TYPE;
  readonly manifest: LhquestReleaseManifest;
  readonly archive: Uint8Array;
}

export type BuildReleaseQuestExportResult =
  | { readonly kind: "exported"; readonly value: ReleaseQuestExport }
  | { readonly kind: "release_not_found" }
  | { readonly kind: "release_integrity_failed" }
  | { readonly kind: "unsupported_dependencies" }
  | { readonly kind: "invalid_request" };

/**
 * Export the exact stored immutable release artifact. No draft read/current
 * pointer lookup/recompile is permitted here. Plugin-authored releases fail
 * closed until import can preserve their authored sidecars without loss.
 */
export async function buildReleaseQuestExport(
  releaseStore: Pick<ControlReleaseStore, "getRelease">,
  projectId: string,
  questId: string,
  releaseId: string
): Promise<BuildReleaseQuestExportResult> {
  if (!isId(projectId) || !isId(questId) || !isId(releaseId)) return frozen({ kind: "invalid_request" });
  const release = await releaseStore.getRelease(projectId, questId, releaseId);
  if (!release) return frozen({ kind: "release_not_found" });
  if (!isControlReleaseRecord(release) || sha256Text(canonicalStringify(release.compiledArtifact)) !== release.compiledContentHash) {
    return frozen({ kind: "release_integrity_failed" });
  }
  if (release.compiledArtifact.release.questId !== questId || release.compiledArtifact.release.releaseId !== releaseId) {
    return frozen({ kind: "release_integrity_failed" });
  }
  if (release.authoredPluginSidecars.length !== 0 || !hasEmptyPluginRequirements(release.pluginRequirementsSidecar, release.compiledContentHash)) {
    return frozen({ kind: "unsupported_dependencies" });
  }

  const artifact = release.compiledArtifact;
  const questDocument = deepFreeze({
    format: "living-history.quest" as const,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    sourceQuestId: questId,
    title: artifact.release.title,
    entryLocationId: artifact.release.entryLocationId,
    blocks: artifact.blocks
  });
  const questBytes = jsonBytes(questDocument);
  const questHash = sha256(questBytes);
  const manifest: LhquestReleaseManifest = deepFreeze({
    format: "living-history.lhquest" as const,
    formatVersion: LHQUEST_FORMAT_VERSION,
    source: {
      kind: "release" as const,
      questId,
      releaseId,
      draftRevision: release.draftRevision,
      draftContentHash: release.draftContentHash,
      compiledContentHash: release.compiledContentHash
    },
    compatibility: {
      contractsSchemaVersion: CONTRACT_SCHEMA_VERSION,
      requiredPlugins: [] as const
    },
    integrity: {
      algorithm: "sha256" as const,
      checksumFile: "SHA256SUMS" as const,
      coveredFiles: ["manifest.json", "quest.json"] as const
    },
    files: [{
      path: "quest.json" as const,
      mediaType: "application/json" as const,
      byteLength: questBytes.byteLength,
      sha256: questHash
    }] as const
  });
  const manifestBytes = jsonBytes(manifest);
  const checksumBytes = utf8(`${sha256(manifestBytes)}  manifest.json\n${questHash}  quest.json\n`);
  const archive = writeStoredZip([
    { path: "manifest.json", bytes: manifestBytes },
    { path: "quest.json", bytes: questBytes },
    { path: "SHA256SUMS", bytes: checksumBytes }
  ]);

  return frozen({
    kind: "exported" as const,
    value: Object.freeze({
      filename: `${questId}.${releaseId}.lhquest.zip`,
      mediaType: LHQUEST_MEDIA_TYPE,
      manifest,
      archive: new Uint8Array(archive)
    })
  });
}

function hasEmptyPluginRequirements(value: unknown, artifactHash: string): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "artifactHash", "requirements"])) return false;
  if (value.schemaVersion !== "1.0" || value.artifactHash !== artifactHash || !isRecord(value.requirements)
    || !hasExactKeys(value.requirements, ["plugins"]) || !Array.isArray(value.requirements.plugins)) return false;
  return value.requirements.plugins.length === 0;
}

function jsonBytes(value: unknown): Uint8Array { return utf8(`${canonicalStringify(value)}\n`); }
function utf8(value: string): Uint8Array { return new TextEncoder().encode(value); }
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function sha256Text(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}
function isRecord(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function hasExactKeys(value: Record<string, any>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function frozen<const T extends object>(value: T): Readonly<T> { return Object.freeze(value); }
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    if (ArrayBuffer.isView(value)) return value;
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
