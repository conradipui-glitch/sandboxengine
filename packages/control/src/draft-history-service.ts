import type { ControlStore } from "./types.js";
import {
  analyzeDraftBlockReferences,
  compareDraftSnapshots,
  draftHistoryEntry,
  type DraftComparison,
  type DraftHistoryEntry,
  type DraftReferenceAnalysis
} from "./draft-history.js";

export type ListDraftHistoryResult =
  | { readonly kind: "found"; readonly currentRevision: number; readonly history: readonly DraftHistoryEntry[] }
  | { readonly kind: "quest_not_found" };

export type CompareDraftRevisionsResult =
  | { readonly kind: "compared"; readonly comparison: DraftComparison }
  | { readonly kind: "quest_not_found" }
  | { readonly kind: "revision_not_found"; readonly revision: number };

export type AnalyzeDraftReferencesResult =
  | { readonly kind: "analyzed"; readonly analysis: DraftReferenceAnalysis }
  | { readonly kind: "quest_not_found" }
  | { readonly kind: "revision_not_found"; readonly revision: number };

/**
 * Read the immutable draft snapshot sequence already owned by ControlStore.
 * Revisions are canonical contiguous integers because every accepted mutation
 * advances exactly one revision and snapshots are append-only.
 */
export async function listDraftHistory(
  store: Pick<ControlStore, "getDraft" | "getDraftSnapshot">,
  projectId: string,
  questId: string
): Promise<ListDraftHistoryResult> {
  const current = await store.getDraft(projectId, questId);
  if (!current) return frozen({ kind: "quest_not_found" });
  const history: DraftHistoryEntry[] = [];
  for (let revision = 0; revision <= current.draftRevision; revision += 1) {
    const snapshot = await store.getDraftSnapshot(projectId, questId, revision);
    if (!snapshot) throw new Error(`corrupt draft history: missing revision ${revision}`);
    history.push(draftHistoryEntry(snapshot));
  }
  return deepFreeze({ kind: "found" as const, currentRevision: current.draftRevision, history });
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

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function frozen<const T extends object>(value: T): Readonly<T> { return Object.freeze(value); }
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
