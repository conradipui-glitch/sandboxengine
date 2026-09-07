// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
import { createHash } from "node:crypto";
import { canonicalStringify } from "@living-history/core";
import type {
  ControlPublicationEvent,
  ControlReleaseStore
} from "@living-history/control";
import type { PluginRegistrySnapshot } from "@living-history/plugins";
import { preflightStoredControlRelease } from "./release-authority.js";

export interface ControlPublicationDependencies {
  readonly releaseStore: ControlReleaseStore;
  readonly pluginRegistry: PluginRegistrySnapshot;
}

export interface PublishControlReleaseInput {
  readonly projectId: string;
  readonly questId: string;
  readonly releaseId: string;
  readonly expectedCurrentReleaseId: string | null;
  readonly actorUserId: string;
  readonly createdAtMs: number;
  readonly idempotencyKey: string;
}

export interface RollbackControlReleaseInput {
  readonly projectId: string;
  readonly questId: string;
  readonly targetReleaseId: string;
  readonly expectedCurrentReleaseId: string;
  readonly actorUserId: string;
  readonly createdAtMs: number;
  readonly idempotencyKey: string;
}

export type PublishControlReleaseResult =
  | { readonly kind: "published"; readonly currentReleaseId: string; readonly event: ControlPublicationEvent }
  | { readonly kind: "unchanged"; readonly currentReleaseId: string }
  | {
      readonly kind: "replay";
      readonly outcome: "published" | "unchanged";
      readonly currentReleaseId: string;
      readonly event: ControlPublicationEvent | null;
    }
  | { readonly kind: "release_not_found" }
  | { readonly kind: "release_preflight_failed"; readonly code: string }
  | { readonly kind: "current_release_conflict"; readonly currentReleaseId: string | null }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "invalid_request" };

export type RollbackControlReleaseResult =
  | { readonly kind: "rolled_back"; readonly currentReleaseId: string; readonly event: ControlPublicationEvent }
  | { readonly kind: "unchanged"; readonly currentReleaseId: string }
  | {
      readonly kind: "replay";
      readonly outcome: "rolled_back" | "unchanged";
      readonly currentReleaseId: string;
      readonly event: ControlPublicationEvent | null;
    }
  | { readonly kind: "release_not_found" }
  | { readonly kind: "release_preflight_failed"; readonly code: string }
  | { readonly kind: "target_not_previously_published" }
  | { readonly kind: "current_release_conflict"; readonly currentReleaseId: string | null }
  | { readonly kind: "idempotency_key_reused" }
  | { readonly kind: "invalid_request" };

/** Publication moves only the pointer after exact stored-release preflight. */
export async function publishControlRelease(
  deps: ControlPublicationDependencies,
  input: PublishControlReleaseInput
): Promise<PublishControlReleaseResult> {
  if (!isPublishInput(input)) return frozen({ kind: "invalid_request" });
  const release = await deps.releaseStore.getRelease(input.projectId, input.questId, input.releaseId);
  if (!release) return frozen({ kind: "release_not_found" });
  const preflight = preflightStoredControlRelease(release, deps.pluginRegistry);
  if (!preflight.ok) return frozen({ kind: "release_preflight_failed", code: preflight.code });
  const requestHash = hashRequest({
    projectId: input.projectId,
    questId: input.questId,
    releaseId: input.releaseId,
    expectedCurrentReleaseId: input.expectedCurrentReleaseId,
    actorUserId: input.actorUserId
  });
  return deps.releaseStore.publishRelease({ ...input, requestHash });
}

/** Rollback is a CAS pointer move to a release proven publishable again now. */
export async function rollbackControlRelease(
  deps: ControlPublicationDependencies,
  input: RollbackControlReleaseInput
): Promise<RollbackControlReleaseResult> {
  if (!isRollbackInput(input)) return frozen({ kind: "invalid_request" });
  const release = await deps.releaseStore.getRelease(input.projectId, input.questId, input.targetReleaseId);
  if (!release) return frozen({ kind: "release_not_found" });
  const preflight = preflightStoredControlRelease(release, deps.pluginRegistry);
  if (!preflight.ok) return frozen({ kind: "release_preflight_failed", code: preflight.code });
  const requestHash = hashRequest({
    projectId: input.projectId,
    questId: input.questId,
    targetReleaseId: input.targetReleaseId,
    expectedCurrentReleaseId: input.expectedCurrentReleaseId,
    actorUserId: input.actorUserId
  });
  return deps.releaseStore.rollbackRelease({ ...input, requestHash });
}

function hashRequest(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}

function isPublishInput(value: unknown): value is PublishControlReleaseInput {
  return isRecord(value)
    && hasExactKeys(value, [
      "projectId", "questId", "releaseId", "expectedCurrentReleaseId", "actorUserId", "createdAtMs", "idempotencyKey"
    ])
    && isId(value.projectId)
    && isId(value.questId)
    && isId(value.releaseId)
    && (value.expectedCurrentReleaseId === null || isId(value.expectedCurrentReleaseId))
    && isId(value.actorUserId)
    && isTimestamp(value.createdAtMs)
    && isId(value.idempotencyKey);
}

function isRollbackInput(value: unknown): value is RollbackControlReleaseInput {
  return isRecord(value)
    && hasExactKeys(value, [
      "projectId", "questId", "targetReleaseId", "expectedCurrentReleaseId", "actorUserId", "createdAtMs", "idempotencyKey"
    ])
    && isId(value.projectId)
    && isId(value.questId)
    && isId(value.targetReleaseId)
    && isId(value.expectedCurrentReleaseId)
    && isId(value.actorUserId)
    && isTimestamp(value.createdAtMs)
    && isId(value.idempotencyKey);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}
function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isRecord(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function frozen<const T extends object>(value: T): Readonly<T> { return Object.freeze(value); }
