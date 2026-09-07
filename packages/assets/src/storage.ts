// @ts-ignore — Node 24 built-ins are pinned by the repository; @types/node is intentionally not a dependency yet.
import { createHash, randomBytes } from "node:crypto";
// @ts-ignore — Node 24 built-ins are pinned by the repository; @types/node is intentionally not a dependency yet.
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
// @ts-ignore — Node 24 built-ins are pinned by the repository; @types/node is intentionally not a dependency yet.
import { dirname, join, resolve } from "node:path";
import { hasValidAssetManifestV2 } from "@living-history/contracts";
import { sha256AssetBytes } from "./inspection.js";
import {
  AssetBoundaryError,
  MAX_STORED_FILENAME_CHARS,
  assertAssetId,
  assertSha256,
  isNodeError,
  type AssetRecord,
  type StoredAsset
} from "./types.js";

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
    if (!(inputBytes instanceof Uint8Array)) {
      throw new AssetBoundaryError("storage_integrity", "Stored bytes must be Uint8Array.");
    }
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
    assertAssetId(assetId);
    assertSha256(hash);
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
    assertSha256(hash);
    return join(this.#root, "objects", hash.slice(0, 2), hash);
  }

  #registryPath(assetId: string, hash: string): string {
    assertAssetId(assetId);
    assertSha256(hash);
    const assetKey = createHash("sha256").update(assetId, "utf8").digest("hex");
    return join(this.#root, "registry", assetKey.slice(0, 2), assetKey, `${hash}.json`);
  }
}

function validateRecord(record: AssetRecord): void {
  if (record === null || typeof record !== "object" || !hasValidAssetManifestV2(record.manifest)) {
    throw new AssetBoundaryError("storage_integrity", "Asset record manifest is invalid.");
  }
  if (!Number.isSafeInteger(record.byteLength) || record.byteLength < 1) {
    throw new AssetBoundaryError("storage_integrity", "Asset record byteLength is invalid.");
  }
  if (record.storageKey !== `sha256:${record.manifest.hash}`) {
    throw new AssetBoundaryError("storage_integrity", "Asset record storageKey is invalid.");
  }
  if (record.originalFilename !== null && (
    typeof record.originalFilename !== "string"
    || record.originalFilename.length < 1
    || record.originalFilename.length > MAX_STORED_FILENAME_CHARS
    || /[\u0000-\u001f\u007f]/.test(record.originalFilename)
  )) {
    throw new AssetBoundaryError("storage_integrity", "Asset record originalFilename is invalid.");
  }
}

async function publishImmutable(
  targetPath: string,
  bytes: Uint8Array,
  verifyExisting: () => Promise<void>
): Promise<void> {
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
