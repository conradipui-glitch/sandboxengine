// @ts-ignore — Node 24 built-ins are pinned by the repository; @types/node is intentionally not a dependency yet.
import { createHash, randomBytes } from "node:crypto";
// @ts-ignore — Node 24 built-ins are pinned by the repository; @types/node is intentionally not a dependency yet.
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
// @ts-ignore — Node 24 built-ins are pinned by the repository; @types/node is intentionally not a dependency yet.
import { dirname, join, resolve } from "node:path";
import {
  PRESENTATION_SCHEMA_VERSION,
  hasValidAssetManifestV2,
  type AssetManifestV2,
  type AssetMimeTypeV2
} from "@living-history/contracts";

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

const CANONICAL_MAX_ALT_TEXT_CHARS = 1_000;
const CANONICAL_MAX_SOURCE_CHARS = 2_000;
const CANONICAL_MAX_RIGHTS_CHARS = 2_000;
const MAX_STORED_FILENAME_CHARS = 1_024;

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
  readonly mimeType: AssetMimeTypeV2;
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

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
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

export function sha256AssetBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function inspectAssetBytes(
  bytes: Uint8Array,
  limits: AssetLimits = DEFAULT_ASSET_LIMITS
): AssetInspection {
  validateLimits(limits);
  if (!(bytes instanceof Uint8Array)) throw new AssetBoundaryError("invalid_request", "Asset bytes must be Uint8Array.");
  if (bytes.byteLength < 1) throw new AssetBoundaryError("malformed_content", "Asset is empty.");
  if (bytes.byteLength > limits.maxInputBytes) throw new AssetBoundaryError("too_large", "Asset exceeds maxInputBytes.");
  if (looksExecutableText(bytes)) throw new AssetBoundaryError("unsupported_type", "Executable/XML/HTML text assets are not supported.");

  let inspection: AssetInspection | null = null;
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) inspection = inspectPng(bytes);
  else if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) inspection = inspectWebp(bytes);
  else if (bytes[0] === 0xff && bytes[1] === 0xd8) inspection = inspectJpeg(bytes);
  else if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WAVE")) inspection = inspectWav(bytes);
  else if (asciiAt(bytes, 0, "OggS")) inspection = inspectOggVorbis(bytes);
  else if (asciiAt(bytes, 0, "ID3") || looksLikeMp3Frame(bytes, 0)) inspection = inspectMp3(bytes);

  if (inspection === null) throw new AssetBoundaryError("unsupported_type", "Unsupported or unrecognized asset bytes.");
  enforceInspectionBounds(inspection, limits);
  return Object.freeze(inspection);
}

export async function ingestAsset(
  store: LocalAssetStore,
  request: AssetIngestRequest,
  limits: AssetLimits = DEFAULT_ASSET_LIMITS
): Promise<AssetRecord> {
  validateLimits(limits);
  validateAssetId(request.assetId);
  if (!(request.bytes instanceof Uint8Array)) throw new AssetBoundaryError("invalid_request", "Asset bytes must be Uint8Array.");
  if (request.bytes.byteLength > limits.maxInputBytes) throw new AssetBoundaryError("too_large", "Asset exceeds maxInputBytes.");

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

export class LocalAssetStore {
  readonly #root: string;

  constructor(storageRoot: string) {
    if (typeof storageRoot !== "string" || storageRoot.trim().length < 1) {
      throw new AssetBoundaryError("invalid_request", "storageRoot must be a non-empty trusted path.");
    }
    this.#root = resolve(storageRoot);
  }

  get storageRoot(): string {
    return this.#root;
  }

  async put(record: AssetRecord, inputBytes: Uint8Array): Promise<void> {
    validateRecord(record);
    if (!(inputBytes instanceof Uint8Array)) throw new AssetBoundaryError("storage_integrity", "Stored bytes must be Uint8Array.");
    const bytes = Uint8Array.from(inputBytes);
    const actualHash = sha256AssetBytes(bytes);
    if (actualHash !== record.manifest.hash || bytes.byteLength !== record.byteLength) {
      throw new AssetBoundaryError("storage_integrity", "Record identity does not match supplied bytes.");
    }

    const objectPath = this.#objectPath(record.manifest.hash);
    await mkdir(dirname(objectPath), { recursive: true });
    await publishImmutable(objectPath, bytes, async () => {
      const existing = await readFile(objectPath);
      const existingBytes = new Uint8Array(existing.buffer, existing.byteOffset, existing.byteLength);
      if (existingBytes.byteLength !== record.byteLength || sha256AssetBytes(existingBytes) !== record.manifest.hash) {
        throw new AssetBoundaryError("storage_integrity", "Existing content-addressed object failed integrity verification.");
      }
    });

    const registryPath = this.#registryPath(record.manifest.id, record.manifest.hash);
    await mkdir(dirname(registryPath), { recursive: true });
    const serialized = `${JSON.stringify(record)}\n`;
    const payload = new TextEncoder().encode(serialized);
    await publishImmutable(registryPath, payload, async () => {
      const existing = await readFile(registryPath, "utf8");
      if (existing !== serialized) {
        throw new AssetBoundaryError("storage_integrity", "Immutable asset registry record already exists with different metadata.");
      }
    });
  }

  async read(assetId: string, hash: string): Promise<StoredAsset> {
    validateAssetId(assetId);
    validateHash(hash);
    const registryPath = this.#registryPath(assetId, hash);
    let recordText: string;
    try {
      recordText = await readFile(registryPath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) throw new AssetBoundaryError("not_found", "Exact assetId + hash registry record was not found.");
      throw error;
    }

    let record: AssetRecord;
    try {
      record = JSON.parse(recordText) as AssetRecord;
    } catch {
      throw new AssetBoundaryError("corrupt_object", "Asset registry record is not valid JSON.");
    }
    try {
      validateRecord(record);
    } catch {
      throw new AssetBoundaryError("corrupt_object", "Asset registry record failed canonical validation.");
    }
    if (record.manifest.id !== assetId || record.manifest.hash !== hash) {
      throw new AssetBoundaryError("corrupt_object", "Asset registry identity does not match requested identity.");
    }

    let raw: any;
    try {
      raw = await readFile(this.#objectPath(hash));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) throw new AssetBoundaryError("not_found", "Content-addressed object is missing.");
      throw error;
    }
    const bytes = Uint8Array.from(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
    if (bytes.byteLength !== record.byteLength || sha256AssetBytes(bytes) !== hash) {
      throw new AssetBoundaryError("corrupt_object", "Stored object failed size/hash verification.");
    }
    Object.freeze(record.manifest);
    Object.freeze(record);
    return Object.freeze({ record, bytes });
  }

  #objectPath(hash: string): string {
    validateHash(hash);
    return join(this.#root, "objects", hash.slice(0, 2), hash);
  }

  #registryPath(assetId: string, hash: string): string {
    validateAssetId(assetId);
    validateHash(hash);
    const assetKey = createHash("sha256").update(assetId, "utf8").digest("hex");
    return join(this.#root, "registry", assetKey.slice(0, 2), assetKey, `${hash}.json`);
  }
}

async function publishImmutable(targetPath: string, bytes: Uint8Array, verifyExisting: () => Promise<void>): Promise<void> {
  try {
    await readFile(targetPath);
    await verifyExisting();
    return;
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }

  const tempPath = `${targetPath}.tmp-${randomBytes(8).toString("hex")}`;
  await writeFile(tempPath, bytes, { flag: "wx" });
  try {
    try {
      await link(tempPath, targetPath);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      await verifyExisting();
    }
  } finally {
    try {
      await unlink(tempPath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
}

function inspectPng(bytes: Uint8Array): AssetInspection {
  let offset = 8;
  let chunkIndex = 0;
  let width: number | null = null;
  let height: number | null = null;
  let sawIend = false;

  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) malformed("PNG chunk header is truncated.");
    const length = readUint32BE(bytes, offset);
    const type = readAscii(bytes, offset + 4, 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.byteLength) malformed("PNG chunk is truncated.");

    if (chunkIndex === 0) {
      if (type !== "IHDR" || length !== 13) malformed("PNG must start with canonical IHDR.");
      width = readUint32BE(bytes, dataStart);
      height = readUint32BE(bytes, dataStart + 4);
      if (width < 1 || height < 1) malformed("PNG dimensions must be positive.");
    } else if (type === "IHDR") {
      malformed("PNG contains duplicate IHDR.");
    }

    if (type === "IEND") {
      if (length !== 0 || chunkEnd !== bytes.byteLength) malformed("PNG IEND must be empty and final.");
      sawIend = true;
      offset = chunkEnd;
      break;
    }

    offset = chunkEnd;
    chunkIndex += 1;
  }

  if (!sawIend || width === null || height === null || offset !== bytes.byteLength) malformed("PNG is missing final IEND.");
  return { kind: "image", mimeType: "image/png", widthPx: width, heightPx: height, durationMs: null };
}

function inspectWebp(bytes: Uint8Array): AssetInspection {
  if (bytes.byteLength < 20 || readUint32LE(bytes, 4) + 8 !== bytes.byteLength) malformed("WebP RIFF size is truncated or inconsistent.");
  const chunk = readAscii(bytes, 12, 4);
  const chunkSize = readUint32LE(bytes, 16);
  const chunkDataEnd = 20 + chunkSize;
  const paddedChunkEnd = chunkDataEnd + (chunkSize % 2);
  if (!Number.isSafeInteger(paddedChunkEnd) || paddedChunkEnd > bytes.byteLength) malformed("WebP first chunk length is truncated or inconsistent.");

  let width = 0;
  let height = 0;
  if (chunk === "VP8X") {
    if (chunkSize !== 10 || bytes.byteLength < 30) malformed("WebP VP8X header is malformed.");
    width = 1 + readUint24LE(bytes, 24);
    height = 1 + readUint24LE(bytes, 27);
  } else if (chunk === "VP8L") {
    if (chunkSize < 5 || bytes.byteLength < 25 || bytes[20] !== 0x2f) malformed("WebP VP8L header is malformed.");
    const b1 = bytes[21] ?? 0;
    const b2 = bytes[22] ?? 0;
    const b3 = bytes[23] ?? 0;
    const b4 = bytes[24] ?? 0;
    width = 1 + (((b2 & 0x3f) << 8) | b1);
    height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
  } else if (chunk === "VP8 ") {
    if (chunkSize < 10 || bytes.byteLength < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) malformed("WebP VP8 frame header is malformed.");
    width = readUint16LE(bytes, 26) & 0x3fff;
    height = readUint16LE(bytes, 28) & 0x3fff;
  } else {
    throw new AssetBoundaryError("unsupported_type", "Unsupported WebP profile.");
  }
  if (width < 1 || height < 1) malformed("WebP dimensions must be positive.");
  return { kind: "image", mimeType: "image/webp", widthPx: width, heightPx: height, durationMs: null };
}

function inspectJpeg(bytes: Uint8Array): AssetInspection {
  if (bytes.byteLength < 4 || bytes[bytes.byteLength - 2] !== 0xff || bytes[bytes.byteLength - 1] !== 0xd9) {
    malformed("JPEG must end with EOI and cannot carry trailing bytes.");
  }
  let offset = 2;
  while (offset + 1 < bytes.byteLength - 2) {
    if (bytes[offset] !== 0xff) malformed("JPEG marker stream is malformed.");
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) break;
    const marker = bytes[offset] ?? 0;
    offset += 1;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xda) malformed("JPEG scan-data parsing is outside the bounded metadata profile before a supported SOF marker.");
    if (offset + 2 > bytes.byteLength) malformed("JPEG segment length is truncated.");
    const segmentLength = readUint16BE(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength - 2) malformed("JPEG segment is truncated.");
    if (isJpegSof(marker)) {
      if (segmentLength < 8) malformed("JPEG SOF segment is too short.");
      const height = readUint16BE(bytes, offset + 3);
      const width = readUint16BE(bytes, offset + 5);
      if (width < 1 || height < 1) malformed("JPEG dimensions must be positive.");
      return { kind: "image", mimeType: "image/jpeg", widthPx: width, heightPx: height, durationMs: null };
    }
    offset += segmentLength;
  }
  malformed("JPEG contains no supported SOF dimensions.");
}

function inspectWav(bytes: Uint8Array): AssetInspection {
  if (bytes.byteLength < 44 || readUint32LE(bytes, 4) + 8 !== bytes.byteLength) malformed("WAV RIFF size is truncated or inconsistent.");
  let offset = 12;
  let byteRate: number | null = null;
  let dataBytes: number | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const id = readAscii(bytes, offset, 4);
    const size = readUint32LE(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.byteLength) malformed("WAV chunk is truncated.");
    if (id === "fmt ") {
      if (size < 16) malformed("WAV fmt chunk is too short.");
      const audioFormat = readUint16LE(bytes, dataStart);
      const channels = readUint16LE(bytes, dataStart + 2);
      const sampleRate = readUint32LE(bytes, dataStart + 4);
      const parsedByteRate = readUint32LE(bytes, dataStart + 8);
      const blockAlign = readUint16LE(bytes, dataStart + 12);
      if (audioFormat !== 1 || channels < 1 || sampleRate < 1 || parsedByteRate < 1 || blockAlign < 1) {
        throw new AssetBoundaryError("unsupported_type", "Only bounded PCM WAV is supported in B07-02.");
      }
      byteRate = parsedByteRate;
    } else if (id === "data") {
      dataBytes = size;
    }
    offset = dataEnd + (size % 2);
  }
  if (byteRate === null || dataBytes === null) malformed("WAV requires fmt and data chunks.");
  const durationMs = Math.round((dataBytes * 1_000) / byteRate);
  return { kind: "audio", mimeType: "audio/wav", widthPx: null, heightPx: null, durationMs };
}

function inspectOggVorbis(bytes: Uint8Array): AssetInspection {
  let offset = 0;
  let sampleRate: number | null = null;
  let lastGranule: bigint | null = null;
  let pageIndex = 0;
  while (offset < bytes.byteLength) {
    if (offset + 27 > bytes.byteLength || !asciiAt(bytes, offset, "OggS") || bytes[offset + 4] !== 0) malformed("Ogg page header is malformed.");
    const segmentCount = bytes[offset + 26] ?? 0;
    const tableStart = offset + 27;
    const bodyStart = tableStart + segmentCount;
    if (bodyStart > bytes.byteLength) malformed("Ogg segment table is truncated.");
    let bodyLength = 0;
    for (let index = 0; index < segmentCount; index += 1) bodyLength += bytes[tableStart + index] ?? 0;
    const pageEnd = bodyStart + bodyLength;
    if (pageEnd > bytes.byteLength) malformed("Ogg page body is truncated.");

    if (pageIndex === 0) {
      if (bodyLength < 30 || bytes[bodyStart] !== 1 || !asciiAt(bytes, bodyStart + 1, "vorbis")) {
        throw new AssetBoundaryError("unsupported_type", "Only Ogg Vorbis identification profile is supported in B07-02.");
      }
      sampleRate = readUint32LE(bytes, bodyStart + 12);
      if (sampleRate < 1) malformed("Ogg Vorbis sample rate is invalid.");
    }

    const granule = readBigUint64LE(bytes, offset + 6);
    if (granule !== 0xffffffffffffffffn) lastGranule = granule;
    offset = pageEnd;
    pageIndex += 1;
  }
  if (pageIndex < 1 || sampleRate === null || lastGranule === null || offset !== bytes.byteLength) malformed("Ogg Vorbis duration metadata is incomplete.");
  if (lastGranule > BigInt(Number.MAX_SAFE_INTEGER)) malformed("Ogg granule position exceeds safe integer bounds.");
  const durationMs = Math.round((Number(lastGranule) * 1_000) / sampleRate);
  return { kind: "audio", mimeType: "audio/ogg", widthPx: null, heightPx: null, durationMs };
}

function inspectMp3(bytes: Uint8Array): AssetInspection {
  let offset = 0;
  if (asciiAt(bytes, 0, "ID3")) {
    if (bytes.byteLength < 10) malformed("MP3 ID3v2 header is truncated.");
    const sizeBytes = [bytes[6] ?? 0, bytes[7] ?? 0, bytes[8] ?? 0, bytes[9] ?? 0];
    if (sizeBytes.some((value) => (value & 0x80) !== 0)) malformed("MP3 ID3v2 size is not sync-safe.");
    const tagSize = ((sizeBytes[0] ?? 0) << 21) | ((sizeBytes[1] ?? 0) << 14) | ((sizeBytes[2] ?? 0) << 7) | (sizeBytes[3] ?? 0);
    offset = 10 + tagSize + (((bytes[5] ?? 0) & 0x10) !== 0 ? 10 : 0);
    if (offset >= bytes.byteLength) malformed("MP3 contains no audio frames after ID3v2.");
  }

  let end = bytes.byteLength;
  if (end - offset >= 128 && asciiAt(bytes, end - 128, "TAG")) end -= 128;
  let totalSamples = 0;
  let streamSampleRate: number | null = null;
  let frames = 0;
  while (offset < end) {
    const header = parseMp3FrameHeader(bytes, offset);
    if (header === null) malformed("MP3 frame stream is malformed or uses an unsupported Layer/profile.");
    if (streamSampleRate === null) streamSampleRate = header.sampleRate;
    if (streamSampleRate !== header.sampleRate) throw new AssetBoundaryError("unsupported_type", "MP3 sample-rate changes are outside the bounded B07-02 profile.");
    if (offset + header.frameLength > end) malformed("MP3 frame is truncated.");
    totalSamples += header.samplesPerFrame;
    offset += header.frameLength;
    frames += 1;
  }
  if (frames < 1 || streamSampleRate === null || offset !== end) malformed("MP3 contains no complete supported frames.");
  const durationMs = Math.round((totalSamples * 1_000) / streamSampleRate);
  return { kind: "audio", mimeType: "audio/mpeg", widthPx: null, heightPx: null, durationMs };
}

function parseMp3FrameHeader(bytes: Uint8Array, offset: number): { sampleRate: number; samplesPerFrame: number; frameLength: number } | null {
  if (offset + 4 > bytes.byteLength) return null;
  const b0 = bytes[offset] ?? 0;
  const b1 = bytes[offset + 1] ?? 0;
  const b2 = bytes[offset + 2] ?? 0;
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  if (versionBits === 1 || layerBits !== 1) return null;
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  if (bitrateIndex < 1 || bitrateIndex > 14 || sampleRateIndex > 2) return null;

  const isMpeg1 = versionBits === 3;
  const bitrateTable = isMpeg1
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const bitrateKbps = bitrateTable[bitrateIndex];
  if (bitrateKbps === undefined) return null;
  const baseRates = [44_100, 48_000, 32_000];
  const baseRate = baseRates[sampleRateIndex];
  if (baseRate === undefined) return null;
  const sampleRate = versionBits === 3 ? baseRate : versionBits === 2 ? baseRate / 2 : baseRate / 4;
  const samplesPerFrame = isMpeg1 ? 1_152 : 576;
  const coefficient = isMpeg1 ? 144 : 72;
  const frameLength = Math.floor((coefficient * bitrateKbps * 1_000) / sampleRate) + padding;
  if (!Number.isSafeInteger(frameLength) || frameLength < 4) return null;
  return { sampleRate, samplesPerFrame, frameLength };
}

function looksLikeMp3Frame(bytes: Uint8Array, offset: number): boolean {
  return parseMp3FrameHeader(bytes, offset) !== null;
}

function enforceInspectionBounds(inspection: AssetInspection, limits: AssetLimits): void {
  if (inspection.kind === "image") {
    const width = inspection.widthPx ?? 0;
    const height = inspection.heightPx ?? 0;
    if (width > limits.maxImageWidth || height > limits.maxImageHeight) {
      throw new AssetBoundaryError("dimensions_exceeded", "Image dimensions exceed configured limits.");
    }
    const pixels = width * height;
    if (!Number.isSafeInteger(pixels) || pixels > limits.maxImagePixels) {
      throw new AssetBoundaryError("dimensions_exceeded", "Image pixel count exceeds configured limits.");
    }
  } else {
    const duration = inspection.durationMs;
    if (duration === null || !Number.isSafeInteger(duration) || duration < 0) malformed("Audio duration could not be proven safely.");
    if (duration > limits.maxAudioDurationMs) throw new AssetBoundaryError("duration_exceeded", "Audio duration exceeds configured limits.");
  }
}

function validateLimits(limits: AssetLimits): void {
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
    if (!Number.isSafeInteger(value) || value < 1) throw new AssetBoundaryError("invalid_request", "Asset limits must be positive safe integers.");
  }
  if (limits.maxFilenameChars > MAX_STORED_FILENAME_CHARS
    || limits.maxAltTextChars > CANONICAL_MAX_ALT_TEXT_CHARS
    || limits.maxSourceChars > CANONICAL_MAX_SOURCE_CHARS
    || limits.maxRightsChars > CANONICAL_MAX_RIGHTS_CHARS) {
    throw new AssetBoundaryError("invalid_request", "Configured metadata limits cannot exceed canonical stored contract bounds.");
  }
}

function validateRecord(record: AssetRecord): void {
  if (record === null || typeof record !== "object" || !hasValidAssetManifestV2(record.manifest)) {
    throw new AssetBoundaryError("storage_integrity", "Asset record manifest is invalid.");
  }
  if (!Number.isSafeInteger(record.byteLength) || record.byteLength < 1) throw new AssetBoundaryError("storage_integrity", "Asset record byteLength is invalid.");
  if (record.storageKey !== `sha256:${record.manifest.hash}`) throw new AssetBoundaryError("storage_integrity", "Asset record storageKey is invalid.");
  if (record.originalFilename !== null && (
    typeof record.originalFilename !== "string"
    || record.originalFilename.length < 1
    || record.originalFilename.length > MAX_STORED_FILENAME_CHARS
    || /[\u0000-\u001f\u007f]/.test(record.originalFilename)
  )) {
    throw new AssetBoundaryError("storage_integrity", "Asset record originalFilename is invalid.");
  }
}

function validateAssetId(assetId: string): void {
  if (typeof assetId !== "string" || !ID_PATTERN.test(assetId)) throw new AssetBoundaryError("invalid_request", "assetId must be a bounded stable ID and cannot contain paths.");
}

function validateHash(hash: string): void {
  if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) throw new AssetBoundaryError("invalid_request", "hash must be lowercase SHA-256 hex.");
}

function validateClaimedMime(claimed: string | null, actual: AssetMimeTypeV2): void {
  if (claimed === null) return;
  if (typeof claimed !== "string" || claimed.trim().length < 1) throw new AssetBoundaryError("invalid_request", "claimedMimeType must be a non-empty string when supplied.");
  const normalized = (claimed.split(";", 1)[0] ?? "").trim().toLowerCase();
  if (normalized !== actual) throw new AssetBoundaryError("mime_mismatch", `Claimed MIME ${normalized} does not match proven ${actual}.`);
}

function validateFilenameExtension(filename: string | null, actual: AssetMimeTypeV2): void {
  if (filename === null) return;
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? filename;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return;
  const extension = base.slice(dot).toLowerCase();
  const expected = MIME_BY_EXTENSION.get(extension);
  if (expected === undefined || expected !== actual) throw new AssetBoundaryError("extension_mismatch", "Original filename extension does not match proven content type.");
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
  if (typeof value !== "string" || value.length < 1 || value.length > max) throw new AssetBoundaryError("invalid_request", `${field} must be bounded non-empty text when supplied.`);
  return value;
}

function looksExecutableText(bytes: Uint8Array): boolean {
  const prefix = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.byteLength, 512)))
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  return prefix.startsWith("<svg")
    || prefix.startsWith("<?xml")
    || prefix.startsWith("<!doctype html")
    || prefix.startsWith("<html")
    || prefix.startsWith("<script")
    || prefix.startsWith("javascript:");
}

function malformed(message: string): never {
  throw new AssetBoundaryError("malformed_content", message);
}

function isJpegSof(marker: number): boolean {
  return [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.byteLength < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

function asciiAt(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (offset < 0 || offset + expected.length > bytes.byteLength) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.byteLength) malformed("Binary metadata read exceeded asset bounds.");
  let value = "";
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(bytes[offset + index] ?? 0);
  return value;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  requireBytes(bytes, offset, 2);
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  requireBytes(bytes, offset, 2);
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  requireBytes(bytes, offset, 3);
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  requireBytes(bytes, offset, 4);
  return (((bytes[offset] ?? 0) * 0x1000000)
    + ((bytes[offset + 1] ?? 0) << 16)
    + ((bytes[offset + 2] ?? 0) << 8)
    + (bytes[offset + 3] ?? 0)) >>> 0;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  requireBytes(bytes, offset, 4);
  return (((bytes[offset + 3] ?? 0) * 0x1000000)
    + ((bytes[offset + 2] ?? 0) << 16)
    + ((bytes[offset + 1] ?? 0) << 8)
    + (bytes[offset] ?? 0)) >>> 0;
}

function readBigUint64LE(bytes: Uint8Array, offset: number): bigint {
  requireBytes(bytes, offset, 8);
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, true);
}

function requireBytes(bytes: Uint8Array, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > bytes.byteLength) malformed("Binary metadata read exceeded asset bounds.");
}

function isNodeError(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code;
}
