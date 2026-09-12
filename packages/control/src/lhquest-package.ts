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
import { cloneJson, isHash, isRevision, isTitle } from "./json-primitives.js";

export interface ParsedLhquestDraftPackage {
  readonly sourceKind: "draft" | "release";
  readonly sourceQuestId: string;
  readonly sourceRevision: number;
  readonly sourceReleaseId: string | null;
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

type PackageSource =
  | { readonly kind: "draft"; readonly questId: string; readonly draftRevision: number; readonly contentHash: string }
  | {
      readonly kind: "release";
      readonly questId: string;
      readonly releaseId: string;
      readonly draftRevision: number;
      readonly draftContentHash: string;
      readonly compiledContentHash: string;
    };

const REQUIRED_FILES = ["SHA256SUMS", "manifest.json", "quest.json"] as const;
const FORBIDDEN_KEY_PATTERN = /(?:secret|password|credential|csrf|token|api[_-]?key|session|player[_-]?state|world[_-]?save|turn[_-]?history|provider[_-]?prompt)/i;
/** Upper bound on JSON nesting accepted from an untrusted package (real manifests/quests stay far below). */
export const MAX_PACKAGE_JSON_DEPTH = 64;

/**
 * Validate a complete v1 lhquest archive without extracting it to disk.
 * The archive is untrusted input: any thrown exception (including stack exhaustion on
 * adversarial nesting) is converted into a fail-closed `INVALID_JSON` result instead of
 * escaping the boundary.
 */
export async function parseLhquestDraftPackage(archive: Uint8Array): Promise<ParseLhquestPackageResult> {
  try {
    return await parseLhquestDraftPackageInner(archive);
  } catch {
    return fail("INVALID_JSON");
  }
}

async function parseLhquestDraftPackageInner(archive: Uint8Array): Promise<ParseLhquestPackageResult> {
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
  | { readonly ok: true; readonly source: PackageSource }
  | { readonly ok: false; readonly code: LhquestPackageFailureCode } {
  if (!isRecord(value) || !hasExactKeys(value, ["format", "formatVersion", "source", "compatibility", "integrity", "files"])) {
    return fail("INVALID_MANIFEST");
  }
  if (value.format !== "living-history.lhquest") return fail("INVALID_MANIFEST");
  if (value.formatVersion !== LHQUEST_FORMAT_VERSION) return fail("UNSUPPORTED_FORMAT_VERSION");

  const source = parseSource(value.source);
  if (source === null) return fail("INVALID_MANIFEST");

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

  return Object.freeze({ ok: true, source });
}

function parseSource(value: unknown): PackageSource | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "draft") {
    if (!hasExactKeys(value, ["kind", "questId", "draftRevision", "contentHash"])
      || !isId(value.questId) || !isRevision(value.draftRevision) || !isHash(value.contentHash)) return null;
    return Object.freeze({ kind: "draft", questId: value.questId, draftRevision: value.draftRevision, contentHash: value.contentHash });
  }
  if (value.kind === "release") {
    if (!hasExactKeys(value, ["kind", "questId", "releaseId", "draftRevision", "draftContentHash", "compiledContentHash"])
      || !isId(value.questId) || !isId(value.releaseId) || !isRevision(value.draftRevision)
      || !isHash(value.draftContentHash) || !isHash(value.compiledContentHash)) return null;
    return Object.freeze({
      kind: "release",
      questId: value.questId,
      releaseId: value.releaseId,
      draftRevision: value.draftRevision,
      draftContentHash: value.draftContentHash,
      compiledContentHash: value.compiledContentHash
    });
  }
  return null;
}

async function validateQuest(
  value: unknown,
  source: PackageSource
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
  const draftRelease = makeRelease(value.sourceQuestId, "draft-content", value.title, value.entryLocationId, blocks);
  if (!hasValidQuestReleaseReferences(draftRelease, blocks)) return fail("INVALID_QUEST");
  const draftCompiled = await compileQuest(draftRelease, blocks);
  if (!draftCompiled.ok) return fail("INVALID_QUEST");

  if (source.kind === "draft") {
    if (draftCompiled.contentHash !== source.contentHash) return fail("SOURCE_CONTENT_HASH_MISMATCH");
  } else {
    if (draftCompiled.contentHash !== source.draftContentHash) return fail("SOURCE_CONTENT_HASH_MISMATCH");
    const releaseCompiled = await compileQuest(
      makeRelease(value.sourceQuestId, source.releaseId, value.title, value.entryLocationId, blocks),
      blocks
    );
    if (!releaseCompiled.ok || releaseCompiled.contentHash !== source.compiledContentHash) {
      return fail("SOURCE_CONTENT_HASH_MISMATCH");
    }
  }

  return Object.freeze({
    ok: true,
    value: deepFreeze({
      sourceKind: source.kind,
      sourceQuestId: source.questId,
      sourceRevision: source.draftRevision,
      sourceReleaseId: source.kind === "release" ? source.releaseId : null,
      sourceContentHash: source.kind === "release" ? source.compiledContentHash : source.contentHash,
      title: value.title,
      entryLocationId: value.entryLocationId,
      blocks
    })
  });
}

function makeRelease(questId: string, releaseId: string, title: string, entryLocationId: string, blocks: readonly Block[]): QuestRelease {
  return Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    questId,
    releaseId,
    title,
    compatibility: Object.freeze({ contractsSchemaVersion: CONTRACT_SCHEMA_VERSION }),
    blockIds: Object.freeze(blocks.map((block) => block.id)),
    entryLocationId
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
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return Object.freeze({ ok: false, code: "INVALID_JSON" });
  }
  if (exceedsJsonDepth(value, MAX_PACKAGE_JSON_DEPTH)) return Object.freeze({ ok: false, code: "INVALID_JSON" });
  return Object.freeze({ ok: true, value });
}

/** Iterative depth probe: never recurses, so adversarial nesting cannot exhaust the stack. */
function exceedsJsonDepth(root: unknown, limit: number): boolean {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: root, depth: 1 }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) continue;
    const value = frame.value;
    const isArray = Array.isArray(value);
    if (!isArray && !isRecord(value)) continue;
    if (frame.depth > limit) return true;
    if (isArray) {
      for (const entry of value as readonly unknown[]) stack.push({ value: entry, depth: frame.depth + 1 });
    } else {
      for (const entry of Object.values(value as Record<string, unknown>)) stack.push({ value: entry, depth: frame.depth + 1 });
    }
  }
  return false;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Iterative walk of untrusted JSON; bounded by an explicit stack so nesting cannot overflow the call stack. */
function containsForbiddenKey(root: unknown): boolean {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      for (const entry of value) stack.push(entry);
      continue;
    }
    if (!isRecord(value)) continue;
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEY_PATTERN.test(key)) return true;
      stack.push(child);
    }
  }
  return false;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
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
function fail<const C extends LhquestPackageFailureCode>(code: C): Readonly<{ ok: false; code: C }> {
  return Object.freeze({ ok: false, code });
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    if (ArrayBuffer.isView(value)) return value;
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
