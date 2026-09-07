export interface BoundedZipEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export type ReadBoundedZipResult =
  | { readonly ok: true; readonly entries: ReadonlyMap<string, BoundedZipEntry> }
  | { readonly ok: false; readonly code: BoundedZipFailureCode };

export type BoundedZipFailureCode =
  | "ARCHIVE_TOO_LARGE"
  | "INVALID_ZIP"
  | "TOO_MANY_FILES"
  | "FILE_TOO_LARGE"
  | "TOTAL_UNPACKED_TOO_LARGE"
  | "UNSUPPORTED_ZIP_FEATURE"
  | "UNSAFE_PATH"
  | "DUPLICATE_PATH"
  | "CRC_MISMATCH";

export const MAX_LHQUEST_ARCHIVE_BYTES = 8 * 1024 * 1024;
export const MAX_LHQUEST_ENTRY_BYTES = 4 * 1024 * 1024;
export const MAX_LHQUEST_UNPACKED_BYTES = 8 * 1024 * 1024;
export const MAX_LHQUEST_FILE_COUNT = 16;

const UTF8_FLAG = 0x0800;
const METHOD_STORE = 0;
const EOCD_SIZE = 22;

/**
 * Parse one bounded ZIP entirely in memory. The B09-03 v1 package profile is
 * deliberately strict: single disk, no Zip64, no data descriptors, no
 * encryption, STORE only, no extras/comments and no filesystem extraction.
 */
export function readBoundedStoredZip(archive: Uint8Array): ReadBoundedZipResult {
  if (!(archive instanceof Uint8Array) || archive.byteLength < EOCD_SIZE) return fail("INVALID_ZIP");
  if (archive.byteLength > MAX_LHQUEST_ARCHIVE_BYTES) return fail("ARCHIVE_TOO_LARGE");

  const endOffset = archive.byteLength - EOCD_SIZE;
  const end = viewAt(archive, endOffset, EOCD_SIZE);
  if (!end || end.getUint32(0, true) !== 0x06054b50) return fail("INVALID_ZIP");
  if (end.getUint16(4, true) !== 0 || end.getUint16(6, true) !== 0) return fail("UNSUPPORTED_ZIP_FEATURE");
  const diskEntries = end.getUint16(8, true);
  const totalEntries = end.getUint16(10, true);
  if (diskEntries !== totalEntries) return fail("UNSUPPORTED_ZIP_FEATURE");
  if (totalEntries < 1) return fail("INVALID_ZIP");
  if (totalEntries > MAX_LHQUEST_FILE_COUNT) return fail("TOO_MANY_FILES");
  const centralSize = end.getUint32(12, true);
  const centralOffset = end.getUint32(16, true);
  const commentLength = end.getUint16(20, true);
  if (commentLength !== 0) return fail("UNSUPPORTED_ZIP_FEATURE");
  if (centralOffset + centralSize !== endOffset || centralOffset >= endOffset) return fail("INVALID_ZIP");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const descriptors: Array<{
    path: string;
    crc: number;
    size: number;
    localOffset: number;
    flags: number;
    method: number;
  }> = [];
  const normalizedPaths = new Set<string>();
  let cursor = centralOffset;
  let totalUnpacked = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    const header = viewAt(archive, cursor, 46);
    if (!header || header.getUint32(0, true) !== 0x02014b50) return fail("INVALID_ZIP");
    const flags = header.getUint16(8, true);
    const method = header.getUint16(10, true);
    const crc = header.getUint32(16, true);
    const compressedSize = header.getUint32(20, true);
    const uncompressedSize = header.getUint32(24, true);
    const nameLength = header.getUint16(28, true);
    const extraLength = header.getUint16(30, true);
    const commentLengthEntry = header.getUint16(32, true);
    const diskStart = header.getUint16(34, true);
    const internalAttributes = header.getUint16(36, true);
    const externalAttributes = header.getUint32(38, true);
    const localOffset = header.getUint32(42, true);

    if (flags !== UTF8_FLAG || method !== METHOD_STORE || compressedSize !== uncompressedSize
      || extraLength !== 0 || commentLengthEntry !== 0 || diskStart !== 0
      || internalAttributes !== 0 || externalAttributes !== 0) {
      return fail("UNSUPPORTED_ZIP_FEATURE");
    }
    if (nameLength < 1) return fail("INVALID_ZIP");
    if (uncompressedSize > MAX_LHQUEST_ENTRY_BYTES) return fail("FILE_TOO_LARGE");
    totalUnpacked += uncompressedSize;
    if (totalUnpacked > MAX_LHQUEST_UNPACKED_BYTES) return fail("TOTAL_UNPACKED_TOO_LARGE");

    const recordEnd = cursor + 46 + nameLength;
    if (recordEnd > centralOffset + centralSize) return fail("INVALID_ZIP");
    let path: string;
    try {
      path = decoder.decode(archive.subarray(cursor + 46, recordEnd));
    } catch {
      return fail("UNSAFE_PATH");
    }
    const normalized = normalizeZipPath(path);
    if (normalized === null) return fail("UNSAFE_PATH");
    if (normalizedPaths.has(normalized)) return fail("DUPLICATE_PATH");
    normalizedPaths.add(normalized);
    descriptors.push({ path: normalized, crc, size: uncompressedSize, localOffset, flags, method });
    cursor = recordEnd;
  }
  if (cursor !== centralOffset + centralSize) return fail("INVALID_ZIP");

  const ranges: Array<{ start: number; end: number }> = [];
  const entries = new Map<string, BoundedZipEntry>();
  for (const descriptor of descriptors) {
    const local = viewAt(archive, descriptor.localOffset, 30);
    if (!local || local.getUint32(0, true) !== 0x04034b50) return fail("INVALID_ZIP");
    const flags = local.getUint16(6, true);
    const method = local.getUint16(8, true);
    const crc = local.getUint32(14, true);
    const compressedSize = local.getUint32(18, true);
    const uncompressedSize = local.getUint32(22, true);
    const nameLength = local.getUint16(26, true);
    const extraLength = local.getUint16(28, true);
    if (flags !== descriptor.flags || method !== descriptor.method || crc !== descriptor.crc
      || compressedSize !== descriptor.size || uncompressedSize !== descriptor.size || extraLength !== 0) {
      return fail("INVALID_ZIP");
    }
    const nameStart = descriptor.localOffset + 30;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > centralOffset) return fail("INVALID_ZIP");
    let localPath: string;
    try {
      localPath = decoder.decode(archive.subarray(nameStart, nameEnd));
    } catch {
      return fail("UNSAFE_PATH");
    }
    if (normalizeZipPath(localPath) !== descriptor.path) return fail("INVALID_ZIP");
    const dataStart = nameEnd;
    const dataEnd = dataStart + descriptor.size;
    if (dataEnd > centralOffset) return fail("INVALID_ZIP");
    ranges.push({ start: descriptor.localOffset, end: dataEnd });
    const bytes = archive.slice(dataStart, dataEnd);
    if (crc32(bytes) !== descriptor.crc) return fail("CRC_MISMATCH");
    entries.set(descriptor.path, Object.freeze({ path: descriptor.path, bytes }));
  }

  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (!previous || !current || current.start < previous.end) return fail("INVALID_ZIP");
  }
  if (ranges.some((range) => range.end > centralOffset)) return fail("INVALID_ZIP");

  return Object.freeze({ ok: true, entries });
}

function normalizeZipPath(path: string): string | null {
  if (path.length < 1 || path.length > 240 || path.includes("\u0000") || path.includes("\\")
    || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return null;
  const normalized = path.normalize("NFC");
  if (normalized !== path) return null;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length < 1 || segment === "." || segment === "..")) return null;
  return normalized;
}

function viewAt(bytes: Uint8Array, offset: number, length: number): DataView | null {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
    || offset + length > bytes.byteLength) return null;
  return new DataView(bytes.buffer, bytes.byteOffset + offset, length);
}

function fail(code: BoundedZipFailureCode): ReadBoundedZipResult {
  return Object.freeze({ ok: false, code });
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    const lookup = CRC_TABLE[(crc ^ byte) & 0xff];
    if (lookup === undefined) throw new Error("CRC table invariant failed");
    crc = lookup ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
