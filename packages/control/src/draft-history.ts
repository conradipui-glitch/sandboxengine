import type { Block } from "@living-history/contracts";
import type { DraftSnapshot } from "./types.js";

export interface DraftHistoryEntry {
  readonly projectId: string;
  readonly questId: string;
  readonly draftRevision: number;
  readonly contentHash: string;
  readonly title: string;
  readonly entryLocationId: string;
  readonly blockCount: number;
}

export interface DraftComparison {
  readonly projectId: string;
  readonly questId: string;
  readonly baseRevision: number;
  readonly targetRevision: number;
  readonly titleChanged: boolean;
  readonly entryLocationChanged: boolean;
  readonly addedBlockIds: readonly string[];
  readonly removedBlockIds: readonly string[];
  readonly replacedBlockIds: readonly string[];
}

export interface DraftReference {
  readonly sourceKind: "quest" | "block";
  readonly sourceId: string;
  readonly path: string;
  readonly targetBlockId: string;
}

export interface DraftReferenceAnalysis {
  readonly projectId: string;
  readonly questId: string;
  readonly draftRevision: number;
  readonly targetBlockId: string;
  readonly targetExists: boolean;
  readonly safeToDelete: boolean;
  readonly references: readonly DraftReference[];
}

/** Safe deterministic metadata for one already-validated immutable draft snapshot. */
export function draftHistoryEntry(snapshot: DraftSnapshot): DraftHistoryEntry {
  return freeze({
    projectId: snapshot.projectId,
    questId: snapshot.questId,
    draftRevision: snapshot.draftRevision,
    contentHash: snapshot.contentHash,
    title: snapshot.title,
    entryLocationId: snapshot.entryLocationId,
    blockCount: snapshot.blocks.length
  });
}

/**
 * Compare two stored revisions of the same quest. This deliberately reports
 * authored object identity changes only; it is not an automatic merge engine.
 */
export function compareDraftSnapshots(base: DraftSnapshot, target: DraftSnapshot): DraftComparison {
  if (base.projectId !== target.projectId || base.questId !== target.questId) {
    throw new TypeError("draft comparison requires the same project and quest");
  }

  const baseById = uniqueBlocks(base.blocks);
  const targetById = uniqueBlocks(target.blocks);
  const addedBlockIds: string[] = [];
  const removedBlockIds: string[] = [];
  const replacedBlockIds: string[] = [];

  for (const id of targetById.keys()) {
    if (!baseById.has(id)) addedBlockIds.push(id);
  }
  for (const id of baseById.keys()) {
    if (!targetById.has(id)) removedBlockIds.push(id);
  }
  for (const [id, block] of baseById) {
    const next = targetById.get(id);
    if (next && canonicalJson(block) !== canonicalJson(next)) replacedBlockIds.push(id);
  }

  addedBlockIds.sort();
  removedBlockIds.sort();
  replacedBlockIds.sort();

  return deepFreeze({
    projectId: base.projectId,
    questId: base.questId,
    baseRevision: base.draftRevision,
    targetRevision: target.draftRevision,
    titleChanged: base.title !== target.title,
    entryLocationChanged: base.entryLocationId !== target.entryLocationId,
    addedBlockIds,
    removedBlockIds,
    replacedBlockIds
  });
}

/**
 * Explain every currently supported authored reference to one block. This is
 * intentionally a bounded typed walk over the canonical B09 block vocabulary,
 * not JSONPath/eval or a heuristic scan for strings that happen to look like IDs.
 */
export function analyzeDraftBlockReferences(snapshot: DraftSnapshot, targetBlockId: string): DraftReferenceAnalysis {
  if (!isId(targetBlockId)) throw new TypeError("invalid target block id");
  const targetExists = snapshot.blocks.some((block) => block.id === targetBlockId);
  const references: DraftReference[] = [];

  if (snapshot.entryLocationId === targetBlockId) {
    references.push(freeze({
      sourceKind: "quest" as const,
      sourceId: snapshot.questId,
      path: "entryLocationId",
      targetBlockId
    }));
  }

  for (const block of snapshot.blocks) {
    if (block.id === targetBlockId) continue;
    if (block.kind === "core.character" && block.data.initialLocationId === targetBlockId) {
      references.push(freeze({
        sourceKind: "block" as const,
        sourceId: block.id,
        path: "data.initialLocationId",
        targetBlockId
      }));
    }
    if (block.kind === "core.action" && block.data.resourceId === targetBlockId) {
      references.push(freeze({
        sourceKind: "block" as const,
        sourceId: block.id,
        path: "data.resourceId",
        targetBlockId
      }));
    }
  }

  references.sort((left, right) => {
    const byKind = left.sourceKind.localeCompare(right.sourceKind);
    if (byKind !== 0) return byKind;
    const byId = left.sourceId.localeCompare(right.sourceId);
    return byId !== 0 ? byId : left.path.localeCompare(right.path);
  });

  return deepFreeze({
    projectId: snapshot.projectId,
    questId: snapshot.questId,
    draftRevision: snapshot.draftRevision,
    targetBlockId,
    targetExists,
    safeToDelete: targetExists && references.length === 0,
    references
  });
}

function uniqueBlocks(blocks: readonly Block[]): ReadonlyMap<string, Block> {
  const byId = new Map<string, Block>();
  for (const block of blocks) {
    if (byId.has(block.id)) throw new TypeError(`duplicate block id in stored draft: ${block.id}`);
    byId.set(block.id, block);
  }
  return byId;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function freeze<const T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
