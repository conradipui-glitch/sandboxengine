// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
import { createHash } from "node:crypto";
import {
  CONTRACT_SCHEMA_VERSION,
  hasValidQuestReleaseReferences,
  isBlock,
  type Block,
  type QuestRelease
} from "@living-history/contracts";
import { compileQuest } from "@living-history/core";
import { LHQUEST_FORMAT_VERSION } from "./quest-export.js";
import { readBoundedStoredZip, type BoundedZipFailureCode } from "./zip-read.js";

export interface ParsedLhquestDraftPackage {
  readonly sourceQuestId: string;
  readonly sourceRevision: number;
  readonly sourceContentHash: string;
  readonly title: string;
  readonly entryLocationId: string;
  readonly blocks: readonly Block[];
}

export type ParseLhquestPackageResult =
  | { readonly ok: true; readonly value: ParsedLhquestDraftPackage }
  | { readonly ok: false; readonly code: LhquestPackageFailureCode };

export type LhquestPackageFailureCode =
  | BoundedZipFailureCode
  | "DISALLOWED_FILE"
  | "MISSING_REQUIRED_FILE"
  | "INVALID_UTF8"
  | "INVALID_JSON"
  | "FORBIDDEN_PACKAGE_SECTION"
  | "UNSUPPORTED_FORMAT_VERSION"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "UNSUPPORTED_PLUGIN_REQUIREMENT"
  | "INVALID_MANIFEST"
  | "INVALID_CHECKSUM_FILE"
  | "HASH_MISMATCH"
  | "INVALID_QUEST"
  | "SOURCE_CONTENT_HASH_MISMATCH";

const REQUIRED_FILES = ["SHA256SUMS", "manifest.json", "quest.json"] as const;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const FORBIDDEN_KEY_PATTERN = /(?:secret|password|credential|csrf|token|api[_-]?key|session|player[_-]?state|world[_-]?save|turn[_-]?history|provider[_-]?prompt)/i;

/** Validate a complete v1 lhquest archive without extracting it to disk. */
export async function parseLhquestDraftPackage(archive: Uint8Array): Promise<ParseLhquestPackageResult> {
  const zip = readBoundedStoredZip(archive);
  if (!zip.ok) return fail(zip.code);
  const paths = [...zip.entries.keys()].sort();
  if (paths.some((path) => !REQUIRED_FILES.includes(path as any))) return fail("DISALLOWED_FILE");
  if (paths.length !== REQUIRED_FILES.length || REQUIRED_FILES.some((path) => !zip.entries.has(path))) {
    return fail("MISSING_REQUIRED_FILE");
  }

  const manifestBytes = zip.entries.get("manifest.json")?.bytes;
  const questBytes = zip.entries.get("quest.json")?.bytes;
  const checksumBytes = zip.entries.get("SHA256SUMS")?.bytes;
  if (!manifestBytes || !questBytes || !checksumBytes) return fail("MISSING_REQUIRED_FILE");

  const manifestParsed = parseJson(manifestBytes);
  const questParsed = parseJson(questBytes);
  if (!manifestParsed.ok) return fail(manifestParsed.code);
  if (!questParsed.ok) return fail(questParsed.code);
  const manifest = manifestParsed.value;
  const quest = questParsed.value;
  if (containsForbiddenKey(manifest) || containsForbiddenKey(quest)) return fail("FORBIDDEN_PACKAGE_SECTION");

  const checksumText = decodeUtf8(checksumBytes);
  if (checksumText === null) return fail("INVALID_UTF8");
  const checksumResult = parseChecksums(checksumText);
  if (!checksumResult.ok) return fail("INVALID_CHECKSUM_FILE");
  if (checksumResult.hashes.get("manifest.json") !== sha256(manifestBytes)
    || checksumResult.hashes.get("quest.json") !== sha256(questBytes)) {
    return fail("HASH_MISMATCH");
  }

  const manifestResult = validateManifest(manifest, questBytes);
  if (!manifestResult.ok) return fail(manifestResult.code);
  const questResult = await validateQuest(quest, manifestResult.source);
  if (!questResult.ok) return fail(questResult.code);
  return Object.freeze({ ok: true, value: questResult.value });
}

function validateManifest(value: unknown, questBytes: Uint8Array):
  | { readonly ok: true; readonly source: { questId: string; draftRevision: number; contentHash: string } }
  | { readonly ok: false; readonly code: LhquestPackageFailureCode } {
  if (!isRecord(value) || !hasExactKeys(value, ["format", "formatVersion", "source", "compatibility", "integrity", "files"])) {
    return fail("INVALID_MANIFEST");
  }
  if (value.format !== "living-history.lhquest") return fail("INVALID_MANIFEST");
  if (value.formatVersion !== LHQUEST_FORMAT_VERSION) return fail("UNSUPPORTED_FORMAT_VERSION");

  if (!isRecord(value.source) || !hasExactKeys(value.source, ["kind", "questId", "draftRevision", "contentHash"])
    || value.source.kind !== "draft" || !isId(value.source.questId)
    || !isRevision(value.source.draftRevision) || !isHash(value.source.contentHash)) {
    return fail("INVALID_MANIFEST");
  }

  if (!isRecord(value.compatibility) || !hasExactKeys(value.compatibility, ["contractsSchemaVersion", "requiredPlugins"])) {
    return fail("INVALID_MANIFEST");
  }
  if (value.compatibility.contractsSchemaVersion !== CONTRACT_SCHEMA_VERSION) return fail("UNSUPPORTED_SCHEMA_VERSION");
  if (!Array.isArray(value.compatibility.requiredPlugins)) return fail("INVALID_MANIFEST");
  if (value.compatibility.requiredPlugins.length !== 0) return fail("UNSUPPORTED_PLUGIN_REQUIREMENT");

  if (!isRecord(value.integrity) || !hasExactKeys(value.integrity, ["algorithm", "checksumFile", "coveredFiles"])
    || value.integrity.algorithm !== "sha256" || value.integrity.checksumFile !== "SHA256SUMS"
    || !Array.isArray(value.integrity.coveredFiles)
    || value.integrity.coveredFiles.length !== 2
    || value.integrity.coveredFiles[0] !== "manifest.json"
    || value.integrity.coveredFiles[1] !== "quest.json") {
    return fail("INVALID_MANIFEST");
  }

  if (!Array.isArray(value.files) || value.files.length !== 1 || !isRecord(value.files[0])) return fail("INVALID_MANIFEST");
  const file = value.files[0];
  if (!hasExactKeys(file, ["path", "mediaType", "byteLength", "sha256"])
    || file.path !== "quest.json" || file.mediaType !== "application/json"
    || !Number.isSafeInteger(file.byteLength) || file.byteLength !== questBytes.byteLength
    || !isHash(file.sha256) || file.sha256 !== sha256(questBytes)) {
    return fail("HASH_MISMATCH");
  }

  return Object.freeze({
    ok: true,
    source: Object.freeze({
      questId: value.source.questId,
      draftRevision: value.source.draftRevision,
      contentHash: value.source.contentHash
    })
  });
}

async function validateQuest(
  value: unknown,
  source: { questId: string; draftRevision: number; contentHash: string }
): Promise<
  | { readonly ok: true; readonly value: ParsedLhquestDraftPackage }
  | { readonly ok: false; readonly code: LhquestPackageFailureCode }
> {
  if (!isRecord(value) || !hasExactKeys(value, ["format", "schemaVersion", "sourceQuestId", "title", "entryLocationId", "blocks"])
    || value.format !== "living-history.quest" || value.schemaVersion !== CONTRACT_SCHEMA_VERSION
    || value.sourceQuestId !== source.questId || !isId(value.sourceQuestId)
    || !isTitle(value.title) || !isId(value.entryLocationId)
    || !Array.isArray(value.blocks) || value.blocks.length < 1 || value.blocks.length > 1_000) {
    return fail("INVALID_QUEST");
  }

  const blocks: Block[] = [];
  for (const raw of value.blocks) {
    if (!isBlock(raw)) return fail("INVALID_QUEST");
    blocks.push(cloneJson(raw));
  }
  const release: QuestRelease = Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    questId: value.sourceQuestId,
    releaseId: "lhquest-import-validation",
    title: value.title,
    compatibility: Object.freeze({ contractsSchemaVersion: CONTRACT_SCHEMA_VERSION }),
    blockIds: Object.freeze(blocks.map((block) => block.id)),
    entryLocationId: value.entryLocationId
  });
  if (!hasValidQuestReleaseReferences(release, blocks)) return fail("INVALID_QUEST");
  const compiled = await compileQuest(release, blocks);
  if (!compiled.ok) return fail("INVALID_QUEST");
  if (compiled.contentHash !== source.contentHash) return fail("SOURCE_CONTENT_HASH_MISMATCH");

  return Object.freeze({
    ok: true,
    value: deepFreeze({
      sourceQuestId: source.questId,
      sourceRevision: source.draftRevision,
      sourceContentHash: source.contentHash,
      title: value.title,
      entryLocationId: value.entryLocationId,
      blocks
    })
  });
}

function parseChecksums(text: string): { ok: true; hashes: ReadonlyMap<string, string> } | { ok: false } {
  if (!text.endsWith("\n")) return Object.freeze({ ok: false });
  const lines = text.slice(0, -1).split("\n");
  if (lines.length !== 2) return Object.freeze({ ok: false });
  const hashes = new Map<string, string>();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (manifest\.json|quest\.json)$/.exec(line);
    if (!match || !match[1] || !match[2] || hashes.has(match[2])) return Object.freeze({ ok: false });
    hashes.set(match[2], match[1]);
  }
  if (hashes.size !== 2 || !hashes.has("manifest.json") || !hashes.has("quest.json")) return Object.freeze({ ok: false });
  return Object.freeze({ ok: true, hashes });
}

function parseJson(bytes: Uint8Array): { ok: true; value: unknown } | { ok: false; code: "INVALID_UTF8" | "INVALID_JSON" } {
  const text = decodeUtf8(bytes);
  if (text === null) return Object.freeze({ ok: false, code: "INVALID_UTF8" });
  try {
    return Object.freeze({ ok: true, value: JSON.parse(text) });
  } catch {
    return Object.freeze({ ok: false, code: "INVALID_JSON" });
  }
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenKey(entry));
  if (!isRecord(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) return true;
    if (containsForbiddenKey(child)) return true;
  }
  return false;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function isHash(value: unknown): value is string { return typeof value === "string" && HASH_PATTERN.test(value); }
function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}
function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isTitle(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200;
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
function fail<const C extends LhquestPackageFailureCode>(code: C): Readonly<{ ok: false; code: C }> {
  return Object.freeze({ ok: false, code });
}
function cloneJson<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    if (ArrayBuffer.isView(value)) return value;
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
