// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
import { createHash } from "node:crypto";
import { canonicalStringify } from "@living-history/core";
import type { ControlStore, RestoreDraftResult } from "@living-history/control";

export interface RestoreControlDraftInput {
  readonly projectId: string;
  readonly questId: string;
  readonly sourceRevision: number;
  readonly baseRevision: number;
  readonly idempotencyKey: string;
}

/**
 * Server-side restore authority. Browser input never supplies the request hash;
 * it is derived from the exact project/quest/source/base identity before storage.
 */
export async function restoreControlDraft(
  store: Pick<ControlStore, "restoreDraft">,
  input: RestoreControlDraftInput
): Promise<RestoreDraftResult> {
  if (!isId(input.projectId) || !isId(input.questId)
    || !isRevision(input.sourceRevision) || !isRevision(input.baseRevision)
    || !isId(input.idempotencyKey)) {
    return Object.freeze({ kind: "invalid_request" });
  }
  const requestHash = createHash("sha256").update(canonicalStringify({
    projectId: input.projectId,
    questId: input.questId,
    sourceRevision: input.sourceRevision,
    baseRevision: input.baseRevision
  }), "utf8").digest("hex");
  return store.restoreDraft(input.projectId, input.questId, {
    sourceRevision: input.sourceRevision,
    baseRevision: input.baseRevision,
    idempotencyKey: input.idempotencyKey,
    requestHash
  });
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}
function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
