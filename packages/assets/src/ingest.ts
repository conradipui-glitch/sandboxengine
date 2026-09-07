import {
  PRESENTATION_SCHEMA_VERSION,
  hasValidAssetManifestV2,
  type AssetManifestV2,
  type AssetMimeTypeV2
} from "@living-history/contracts";
import { inspectAssetBytes, sha256AssetBytes } from "./inspection.js";
import type { LocalAssetStore } from "./storage.js";
import {
  AssetBoundaryError,
  DEFAULT_ASSET_LIMITS,
  assertAssetId,
  assertAssetLimits,
  type AssetIngestRequest,
  type AssetLimits,
  type AssetRecord
} from "./types.js";

const MIME_BY_EXTENSION = new Map<string, AssetMimeTypeV2>([
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".oga", "audio/ogg"],
  [".wav", "audio/wav"],
  [".wave", "audio/wav"]
]);

export async function ingestAsset(
  store: LocalAssetStore,
  request: AssetIngestRequest,
  limits: AssetLimits = DEFAULT_ASSET_LIMITS
): Promise<AssetRecord> {
  assertAssetLimits(limits);
  assertAssetId(request.assetId);
  if (!(request.bytes instanceof Uint8Array)) {
    throw new AssetBoundaryError("invalid_request", "Asset bytes must be Uint8Array.");
  }
  if (request.bytes.byteLength > limits.maxInputBytes) {
    throw new AssetBoundaryError("too_large", "Asset exceeds maxInputBytes.");
  }

  const originalFilename = normalizeFilename(request.originalFilename ?? null, limits.maxFilenameChars);
  const bytes = Uint8Array.from(request.bytes);
  const inspection = inspectAssetBytes(bytes, limits);
  validateClaimedMime(request.claimedMimeType ?? null, inspection.mimeType);
  validateFilenameExtension(originalFilename, inspection.mimeType);

  const hash = sha256AssetBytes(bytes);
  const manifest: AssetManifestV2 = Object.freeze({
    schemaVersion: PRESENTATION_SCHEMA_VERSION,
    id: request.assetId,
    hash,
    kind: inspection.kind,
    mimeType: inspection.mimeType,
    widthPx: inspection.widthPx,
    heightPx: inspection.heightPx,
    durationMs: inspection.durationMs,
    altText: inspection.kind === "image"
      ? requiredText(request.altText, limits.maxAltTextChars, "altText")
      : nullableText(request.altText, limits.maxAltTextChars, "altText"),
    source: nullableText(request.source, limits.maxSourceChars, "source"),
    rights: nullableText(request.rights, limits.maxRightsChars, "rights")
  });

  if (!hasValidAssetManifestV2(manifest)) {
    throw new AssetBoundaryError("invalid_request", "Generated manifest failed the canonical B07 presentation contract.");
  }

  const record: AssetRecord = Object.freeze({
    manifest,
    byteLength: bytes.byteLength,
    storageKey: `sha256:${hash}`,
    originalFilename
  });
  await store.put(record, bytes);
  return record;
}

function validateClaimedMime(claimed: string | null, actual: AssetMimeTypeV2): void {
  if (claimed === null) return;
  if (typeof claimed !== "string" || claimed.trim().length < 1) {
    throw new AssetBoundaryError("invalid_request", "claimedMimeType must be a non-empty string when supplied.");
  }
  const normalized = (claimed.split(";", 1)[0] ?? "").trim().toLowerCase();
  if (normalized !== actual) {
    throw new AssetBoundaryError("mime_mismatch", `Claimed MIME ${normalized} does not match proven ${actual}.`);
  }
}

function validateFilenameExtension(filename: string | null, actual: AssetMimeTypeV2): void {
  if (filename === null) return;
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? filename;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return;
  const extension = base.slice(dot).toLowerCase();
  const expected = MIME_BY_EXTENSION.get(extension);
  if (expected === undefined || expected !== actual) {
    throw new AssetBoundaryError("extension_mismatch", "Original filename extension does not match proven content type.");
  }
}

function normalizeFilename(value: string | null, max: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AssetBoundaryError("invalid_request", "originalFilename is invalid display metadata.");
  }
  return value;
}

function requiredText(value: string | null | undefined, max: number, field: string): string {
  const normalized = nullableText(value, max, field);
  if (normalized === null) throw new AssetBoundaryError("invalid_request", `${field} is required for visual assets.`);
  return normalized;
}

function nullableText(value: string | null | undefined, max: number, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new AssetBoundaryError("invalid_request", `${field} must be bounded non-empty text when supplied.`);
  }
  return value;
}
