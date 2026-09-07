import type { AssetManifestV2 } from "@living-history/contracts";

export const ASSET_ERROR_CODES = [
  "invalid_request",
  "too_large",
  "unsupported_type",
  "mime_mismatch",
  "extension_mismatch",
  "malformed_content",
  "dimensions_exceeded",
  "duration_exceeded",
  "storage_integrity",
  "not_found",
  "corrupt_object"
] as const;
export type AssetErrorCode = (typeof ASSET_ERROR_CODES)[number];

export class AssetBoundaryError extends Error {
  readonly code: AssetErrorCode;

  constructor(code: AssetErrorCode, message: string) {
    super(message);
    this.name = "AssetBoundaryError";
    this.code = code;
  }
}

export interface AssetLimits {
  readonly maxInputBytes: number;
  readonly maxImageWidth: number;
  readonly maxImageHeight: number;
  readonly maxImagePixels: number;
  readonly maxAudioDurationMs: number;
  readonly maxFilenameChars: number;
  readonly maxAltTextChars: number;
  readonly maxSourceChars: number;
  readonly maxRightsChars: number;
}

export const CANONICAL_MAX_ALT_TEXT_CHARS = 1_000;
export const CANONICAL_MAX_SOURCE_CHARS = 2_000;
export const CANONICAL_MAX_RIGHTS_CHARS = 2_000;
export const MAX_STORED_FILENAME_CHARS = 1_024;

export const DEFAULT_ASSET_LIMITS: AssetLimits = Object.freeze({
  maxInputBytes: 20 * 1024 * 1024,
  maxImageWidth: 8_192,
  maxImageHeight: 8_192,
  maxImagePixels: 40_000_000,
  maxAudioDurationMs: 10 * 60_000,
  maxFilenameChars: 255,
  maxAltTextChars: CANONICAL_MAX_ALT_TEXT_CHARS,
  maxSourceChars: CANONICAL_MAX_SOURCE_CHARS,
  maxRightsChars: CANONICAL_MAX_RIGHTS_CHARS
});

export interface AssetInspection {
  readonly kind: "image" | "audio";
  readonly mimeType: AssetManifestV2["mimeType"];
  readonly widthPx: number | null;
  readonly heightPx: number | null;
  readonly durationMs: number | null;
}

export interface AssetIngestRequest {
  readonly assetId: string;
  readonly bytes: Uint8Array;
  readonly claimedMimeType?: string | null;
  readonly originalFilename?: string | null;
  readonly altText?: string | null;
  readonly source?: string | null;
  readonly rights?: string | null;
}

export interface AssetRecord {
  readonly manifest: AssetManifestV2;
  readonly byteLength: number;
  readonly storageKey: string;
  readonly originalFilename: string | null;
}

export interface StoredAsset {
  readonly record: AssetRecord;
  readonly bytes: Uint8Array;
}

export const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function assertAssetId(assetId: string): void {
  if (typeof assetId !== "string" || !ASSET_ID_PATTERN.test(assetId)) {
    throw new AssetBoundaryError("invalid_request", "assetId must be a bounded stable ID and cannot contain paths.");
  }
}

export function assertSha256(hash: string): void {
  if (typeof hash !== "string" || !SHA256_PATTERN.test(hash)) {
    throw new AssetBoundaryError("invalid_request", "hash must be lowercase SHA-256 hex.");
  }
}

export function assertAssetLimits(limits: AssetLimits): void {
  for (const value of [
    limits.maxInputBytes,
    limits.maxImageWidth,
    limits.maxImageHeight,
    limits.maxImagePixels,
    limits.maxAudioDurationMs,
    limits.maxFilenameChars,
    limits.maxAltTextChars,
    limits.maxSourceChars,
    limits.maxRightsChars
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new AssetBoundaryError("invalid_request", "Asset limits must be positive safe integers.");
    }
  }
  if (limits.maxFilenameChars > MAX_STORED_FILENAME_CHARS
    || limits.maxAltTextChars > CANONICAL_MAX_ALT_TEXT_CHARS
    || limits.maxSourceChars > CANONICAL_MAX_SOURCE_CHARS
    || limits.maxRightsChars > CANONICAL_MAX_RIGHTS_CHARS) {
    throw new AssetBoundaryError("invalid_request", "Configured metadata limits cannot exceed canonical stored contract bounds.");
  }
}

export function isNodeError(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code;
}
