// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
import { createHash } from "node:crypto";
import { CONTRACT_SCHEMA_VERSION } from "@living-history/contracts";
import { canonicalStringify } from "@living-history/core";
import type { ControlStore } from "./types.js";
import { writeStoredZip } from "./zip-store.js";

export const LHQUEST_FORMAT_VERSION = "1.0" as const;
export const LHQUEST_MEDIA_TYPE = "application/vnd.living-history.quest+zip" as const;

export interface LhquestDraftManifest {
  readonly format: "living-history.lhquest";
  readonly formatVersion: typeof LHQUEST_FORMAT_VERSION;
  readonly source: {
    readonly kind: "draft";
    readonly questId: string;
    readonly draftRevision: number;
    readonly contentHash: string;
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

export interface DraftQuestExport {
  readonly filename: string;
  readonly mediaType: typeof LHQUEST_MEDIA_TYPE;
  readonly manifest: LhquestDraftManifest;
  readonly archive: Uint8Array;
}

export type BuildDraftQuestExportResult =
  | { readonly kind: "exported"; readonly value: DraftQuestExport }
  | { readonly kind: "quest_not_found" }
  | { readonly kind: "revision_not_found"; readonly revision: number }
  | { readonly kind: "invalid_request" };

/**
 * Export one exact immutable draft snapshot as inert deterministic data.
 * No security/session/runtime/release store is accepted here, so unrelated
 * credentials and player state are structurally outside the export boundary.
 */
export async function buildDraftQuestExport(
  store: Pick<ControlStore, "getDraft" | "getDraftSnapshot">,
  projectId: string,
  questId: string,
  draftRevision: number
): Promise<BuildDraftQuestExportResult> {
  if (!isId(projectId) || !isId(questId) || !isRevision(draftRevision)) return frozen({ kind: "invalid_request" });
  const current = await store.getDraft(projectId, questId);
  if (!current) return frozen({ kind: "quest_not_found" });
  const snapshot = await store.getDraftSnapshot(projectId, questId, draftRevision);
  if (!snapshot) return frozen({ kind: "revision_not_found", revision: draftRevision });

  const questDocument = deepFreeze({
    format: "living-history.quest" as const,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    sourceQuestId: snapshot.questId,
    title: snapshot.title,
    entryLocationId: snapshot.entryLocationId,
    blocks: snapshot.blocks
  });
  const questBytes = jsonBytes(questDocument);
  const questHash = sha256(questBytes);

  const manifest: LhquestDraftManifest = deepFreeze({
    format: "living-history.lhquest" as const,
    formatVersion: LHQUEST_FORMAT_VERSION,
    source: {
      kind: "draft" as const,
      questId: snapshot.questId,
      draftRevision: snapshot.draftRevision,
      contentHash: snapshot.contentHash
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
  const checksumBytes = utf8(
    `${sha256(manifestBytes)}  manifest.json\n${questHash}  quest.json\n`
  );
  const archive = writeStoredZip([
    { path: "manifest.json", bytes: manifestBytes },
    { path: "quest.json", bytes: questBytes },
    { path: "SHA256SUMS", bytes: checksumBytes }
  ]);

  return frozen({
    kind: "exported" as const,
    value: deepFreeze({
      filename: `${questId}.r${draftRevision}.lhquest.zip`,
      mediaType: LHQUEST_MEDIA_TYPE,
      manifest,
      archive
    })
  });
}

function jsonBytes(value: unknown): Uint8Array {
  return utf8(`${canonicalStringify(value)}\n`);
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}
function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function frozen<const T extends object>(value: T): Readonly<T> { return Object.freeze(value); }
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
