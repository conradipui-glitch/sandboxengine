import type { ControlStore } from "./types.js";
import {
  analyzeDraftBlockReferences,
  compareDraftSnapshots,
  draftHistoryEntry,
  type DraftComparison,
  type DraftHistoryEntry,
  type DraftReferenceAnalysis
} from "./draft-history.js";
import { isRevision } from "./json-primitives.js";

export const DEFAULT_DRAFT_HISTORY_LIMIT = 100;
export const MAX_DRAFT_HISTORY_LIMIT = 200;

export interface DraftHistoryPageOptions {
  readonly beforeRevision?: number;
  readonly limit?: number;
}

export type ListDraftHistoryResult =
  | {
      readonly kind: "found";
      readonly currentRevision: number;
      readonly history: readonly DraftHistoryEntry[];
      readonly nextBeforeRevision: number | null;
    }
  | { readonly kind: "quest_not_found" }
  | { readonly kind: "invalid_request" };

export type CompareDraftRevisionsResult =
  | { readonly kind: "compared"; readonly comparison: DraftComparison }
  | { readonly kind: "quest_not_found" }
  | { readonly kind: "revision_not_found"; readonly revision: number };

export type AnalyzeDraftReferencesResult =
  | { readonly kind: "analyzed"; readonly analysis: DraftReferenceAnalysis }
  | { readonly kind: "quest_not_found" }
  | { readonly kind: "revision_not_found"; readonly revision: number };

/**
 * Read one bounded page from the immutable draft snapshot sequence already
 * owned by ControlStore. The default page is the newest 100 revisions, while
 * entries inside a page remain ascending for human comparison.
 */
export async function listDraftHistory(
  store: Pick<ControlStore, "getDraft" | "getDraftSnapshot">,
  projectId: string,
  questId: string,
  options: DraftHistoryPageOptions = {}
): Promise<ListDraftHistoryResult> {
  if (!isPageOptions(options)) return frozen({ kind: "invalid_request" });
  const current = await store.getDraft(projectId, questId);
  if (!current) return frozen({ kind: "quest_not_found" });

  const limit = options.limit ?? DEFAULT_DRAFT_HISTORY_LIMIT;
  const requestedEnd = options.beforeRevision ?? current.draftRevision;
  if (requestedEnd > current.draftRevision) return frozen({ kind: "invalid_request" });
  const start = Math.max(0, requestedEnd - limit + 1);
  const history: DraftHistoryEntry[] = [];
  for (let revision = start; revision <= requestedEnd; revision += 1) {
    const snapshot = await store.getDraftSnapshot(projectId, questId, revision);
    if (!snapshot) throw new Error(`corrupt draft history: missing revision ${revision}`);
    history.push(draftHistoryEntry(snapshot));
  }
  return deepFreeze({
    kind: "found" as const,
    currentRevision: current.draftRevision,
    history,
    nextBeforeRevision: start > 0 ? start - 1 : null
  });
}

export async function compareDraftRevisions(
  store: Pick<ControlStore, "getDraft" | "getDraftSnapshot">,
  projectId: string,
  questId: string,
  baseRevision: number,
  targetRevision: number
): Promise<CompareDraftRevisionsResult> {
  const current = await store.getDraft(projectId, questId);
  if (!current) return frozen({ kind: "quest_not_found" });
  if (!isRevision(baseRevision)) return frozen({ kind: "revision_not_found", revision: baseRevision });
  if (!isRevision(targetRevision)) return frozen({ kind: "revision_not_found", revision: targetRevision });
  const base = await store.getDraftSnapshot(projectId, questId, baseRevision);
  if (!base) return frozen({ kind: "revision_not_found", revision: baseRevision });
  const target = await store.getDraftSnapshot(projectId, questId, targetRevision);
  if (!target) return frozen({ kind: "revision_not_found", revision: targetRevision });
  return frozen({ kind: "compared", comparison: compareDraftSnapshots(base, target) });
}

export async function analyzeDraftReferences(
  store: Pick<ControlStore, "getDraft" | "getDraftSnapshot">,
  projectId: string,
  questId: string,
  revision: number,
  targetBlockId: string
): Promise<AnalyzeDraftReferencesResult> {
  const current = await store.getDraft(projectId, questId);
  if (!current) return frozen({ kind: "quest_not_found" });
  if (!isRevision(revision)) return frozen({ kind: "revision_not_found", revision });
  const snapshot = await store.getDraftSnapshot(projectId, questId, revision);
  if (!snapshot) return frozen({ kind: "revision_not_found", revision });
  return frozen({ kind: "analyzed", analysis: analyzeDraftBlockReferences(snapshot, targetBlockId) });
}

function isPageOptions(value: unknown): value is DraftHistoryPageOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "beforeRevision" && key !== "limit")) return false;
  if (record.beforeRevision !== undefined && !isRevision(record.beforeRevision)) return false;
  if (record.limit !== undefined
    && (typeof record.limit !== "number" || !Number.isSafeInteger(record.limit)
      || record.limit < 1 || record.limit > MAX_DRAFT_HISTORY_LIMIT)) return false;
  return true;
}

function frozen<const T extends object>(value: T): Readonly<T> { return Object.freeze(value); }
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
