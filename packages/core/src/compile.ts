import {
  CONTRACT_SCHEMA_VERSION,
  hasValidQuestReleaseReferences,
  type Block,
  type QuestRelease
} from "@living-history/contracts";

export interface CompiledQuestArtifact {
  readonly release: QuestRelease;
  readonly blocks: readonly Block[];
}

export interface CompileQuestSuccess {
  readonly ok: true;
  readonly artifact: CompiledQuestArtifact;
  readonly canonicalJson: string;
  readonly contentHash: string;
  readonly contentHashAlgorithm: "sha256";
}

export interface CompileQuestFailure {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type CompileQuestResult = CompileQuestSuccess | CompileQuestFailure;

/**
 * B01 compile skeleton. Inputs are expected to have passed their JSON Schemas;
 * this layer re-checks contract versions and semantic cross-block invariants,
 * normalizes block order to the release manifest and produces one immutable
 * content artifact. It does not resolve or execute actions.
 */
export async function compileQuest(
  release: QuestRelease,
  blocks: readonly Block[]
): Promise<CompileQuestResult> {
  const errors: string[] = [];

  if (release.schemaVersion !== CONTRACT_SCHEMA_VERSION) {
    errors.push("release.schema_version");
  }
  if (release.compatibility.contractsSchemaVersion !== CONTRACT_SCHEMA_VERSION) {
    errors.push("release.compatibility");
  }
  for (const block of blocks) {
    if (block.schemaVersion !== CONTRACT_SCHEMA_VERSION) {
      errors.push(`block.schema_version:${block.id}`);
    }
  }
  if (!hasValidQuestReleaseReferences(release, blocks)) {
    errors.push("release.references");
  }

  if (errors.length > 0) {
    return Object.freeze({ ok: false, errors: Object.freeze([...errors]) });
  }

  const byId = new Map(blocks.map((block) => [block.id, block] as const));
  const orderedBlocks = release.blockIds.map((id) => byId.get(id));
  if (orderedBlocks.some((block) => block === undefined)) {
    return Object.freeze({ ok: false, errors: Object.freeze(["release.references"]) });
  }

  const artifact = deepFreeze({
    release: cloneJson(release),
    blocks: orderedBlocks.map((block) => cloneJson(block as Block))
  }) as CompiledQuestArtifact;
  const canonicalJson = canonicalStringify(artifact);
  const contentHash = await sha256Hex(canonicalJson);

  return Object.freeze({
    ok: true,
    artifact,
    canonicalJson,
    contentHash,
    contentHashAlgorithm: "sha256" as const
  });
}

/** Recursively sorts object keys while preserving array order. */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("Value is not JSON serializable");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`)
    .join(",")}}`;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
