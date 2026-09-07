export interface StoredZipEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

const UTF8_FLAG = 0x0800;
const METHOD_STORE = 0;
const DOS_TIME = 0;
const DOS_DATE = 0x0021; // 1980-01-01
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = 20;
const MAX_ENTRIES = 64;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

/**
 * Minimal deterministic ZIP encoder for inert lhquest packages.
 * It intentionally supports only STORE (no compression), no extras/comments,
 * UTF-8 names, no Zip64 and bounded total sizes.
 */
export function writeStoredZip(entries: readonly StoredZipEntry[]): Uint8Array {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_ENTRIES) {
    throw new RangeError("ZIP entry count outside bounds");
  }

  const normalized = entries.map((entry) => {
    if (!isSafeZipPath(entry.path)) throw new TypeError(`unsafe ZIP path: ${entry.path}`);
    if (!(entry.bytes instanceof Uint8Array) || entry.bytes.byteLength > MAX_ENTRY_BYTES) {
      throw new RangeError(`ZIP entry outside bounds: ${entry.path}`);
    }
    return Object.freeze({ path: entry.path, bytes: new Uint8Array(entry.bytes) });
  });
  const paths = normalized.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) throw new TypeError("duplicate ZIP path");

  const ordered = [...normalized].sort((left, right) => left.path.localeCompare(right.path));
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of ordered) {
    const name = encoder.encode(entry.path);
    if (name.byteLength < 1 || name.byteLength > 0xffff) throw new RangeError("ZIP filename outside bounds");
    const crc = crc32(entry.bytes);

    const local = new Uint8Array(30 + name.byteLength + entry.bytes.byteLength);
    const localView = new DataView(local.buffer, local.byteOffset, local.byteLength);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, VERSION_NEEDED, true);
    localView.setUint16(6, UTF8_FLAG, true);
    localView.setUint16(8, METHOD_STORE, true);
    localView.setUint16(10, DOS_TIME, true);
    localView.setUint16(12, DOS_DATE, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, entry.bytes.byteLength, true);
    localView.setUint32(22, entry.bytes.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    localView.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(entry.bytes, 30 + name.byteLength);
    locals.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer, central.byteOffset, central.byteLength);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, VERSION_MADE_BY, true);
    centralView.setUint16(6, VERSION_NEEDED, true);
    centralView.setUint16(8, UTF8_FLAG, true);
    centralView.setUint16(10, METHOD_STORE, true);
    centralView.setUint16(12, DOS_TIME, true);
    centralView.setUint16(14, DOS_DATE, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, entry.bytes.byteLength, true);
    centralView.setUint32(24, entry.bytes.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.byteLength;
    if (offset > MAX_ARCHIVE_BYTES) throw new RangeError("ZIP archive outside bounds");
  }

  const centralOffset = offset;
  const centralSize = centrals.reduce((sum, entry) => sum + entry.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer, end.byteOffset, end.byteLength);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, ordered.length, true);
  endView.setUint16(10, ordered.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  endView.setUint16(20, 0, true);

  const total = centralOffset + centralSize + end.byteLength;
  if (total > MAX_ARCHIVE_BYTES || total > 0xffffffff) throw new RangeError("ZIP archive outside bounds");
  const archive = new Uint8Array(total);
  let cursor = 0;
  for (const local of locals) { archive.set(local, cursor); cursor += local.byteLength; }
  for (const central of centrals) { archive.set(central, cursor); cursor += central.byteLength; }
  archive.set(end, cursor);
  return archive;
}

function isSafeZipPath(path: unknown): path is string {
  return typeof path === "string"
    && path.length >= 1
    && path.length <= 240
    && !path.includes("\u0000")
    && !path.includes("\\")
    && !path.startsWith("/")
    && !/^[A-Za-z]:/.test(path)
    && path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
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
