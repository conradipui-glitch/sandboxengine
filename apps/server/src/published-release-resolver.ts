import {
  CONTRACT_SCHEMA_VERSION,
  hasValidWorldStateReferences,
  type WorldState
} from "@living-history/contracts";
import type { ControlReleaseRecord, ControlReleaseStore } from "@living-history/control";
import type { PluginRegistrySnapshot } from "@living-history/plugins";
import type { IntentActionCatalogEntry } from "@living-history/ai";
import type { PinnedReleaseIdentity } from "@living-history/runtime";
import {
  createCoreExplicitActionExecutorForDefinition,
  createPaintIntentCatalog,
  type ExplicitActionExecutor
} from "./action-service.js";
import { preflightStoredControlRelease } from "./release-authority.js";
import type { PublishedSessionBinding } from "./published-session-binding.js";

export interface PublishedRuntimeTemplate {
  readonly sourceProjectId: string;
  readonly release: PinnedReleaseIdentity;
  readonly initialState: WorldState;
  readonly executor: ExplicitActionExecutor | null;
  readonly intentCatalog: readonly IntentActionCatalogEntry[];
}

export interface PublishedReleaseResolverDependencies {
  readonly releaseStore: ControlReleaseStore;
  readonly pluginRegistry: PluginRegistrySnapshot;
}

export type ResolvePublishedReleaseResult =
  | { readonly ok: true; readonly template: PublishedRuntimeTemplate }
  | {
      readonly ok: false;
      readonly code:
        | "NO_CURRENT_RELEASE"
        | "RELEASE_NOT_FOUND"
        | "PINNED_RELEASE_MISMATCH"
        | "RELEASE_PREFLIGHT_FAILED"
        | "UNSUPPORTED_ACTION_ROUTING";
    };

export async function resolveCurrentPublishedRelease(
  deps: PublishedReleaseResolverDependencies,
  projectId: string,
  questId: string
): Promise<ResolvePublishedReleaseResult> {
  if (!isId(projectId) || !isId(questId)) return frozen({ ok: false, code: "RELEASE_NOT_FOUND" });
  const currentReleaseId = await deps.releaseStore.getCurrentReleaseId(projectId, questId);
  if (currentReleaseId === null) return frozen({ ok: false, code: "NO_CURRENT_RELEASE" });
  const release = await deps.releaseStore.getRelease(projectId, questId, currentReleaseId);
  if (!release) return frozen({ ok: false, code: "RELEASE_NOT_FOUND" });
  return materializePublishedRuntimeTemplate(deps, release);
}

/** Resolve an existing session strictly from its durable project binding + pinned triple, never from current pointer. */
export async function resolvePinnedPublishedRelease(
  deps: PublishedReleaseResolverDependencies,
  binding: PublishedSessionBinding
): Promise<ResolvePublishedReleaseResult> {
  const release = await deps.releaseStore.getRelease(binding.projectId, binding.release.questId, binding.release.releaseId);
  if (!release) return frozen({ ok: false, code: "RELEASE_NOT_FOUND" });
  if (release.compiledContentHash.toLowerCase() !== binding.release.contentHash.toLowerCase()) {
    return frozen({ ok: false, code: "PINNED_RELEASE_MISMATCH" });
  }
  return materializePublishedRuntimeTemplate(deps, release);
}

export function materializePublishedRuntimeTemplate(
  deps: PublishedReleaseResolverDependencies,
  release: ControlReleaseRecord
): ResolvePublishedReleaseResult {
  const preflight = preflightStoredControlRelease(release, deps.pluginRegistry);
  if (!preflight.ok) return frozen({ ok: false, code: "RELEASE_PREFLIGHT_FAILED" });

  const actionBlocks = release.compiledArtifact.blocks.filter((block) => block.kind === "core.action");
  if (actionBlocks.length > 1) return frozen({ ok: false, code: "UNSUPPORTED_ACTION_ROUTING" });
  const action = actionBlocks[0] ?? null;
  const executor = action === null ? null : createCoreExplicitActionExecutorForDefinition({
    id: action.id,
    actionType: action.data.actionType,
    resourceId: action.data.resourceId,
    resourceUnitsPerUnit: action.data.resourceUnitsPerUnit,
    durationSecondsPerUnit: action.data.durationSecondsPerUnit,
    allowPartial: action.data.allowPartial
  });

  const state: WorldState = deepFreeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    revision: 0,
    clock: { elapsedSeconds: 0 },
    locations: release.compiledArtifact.blocks
      .filter((block) => block.kind === "core.location")
      .map((block) => ({ id: block.id })),
    entities: release.compiledArtifact.blocks
      .filter((block) => block.kind === "core.character")
      .map((block) => ({
        id: block.id,
        type: "character",
        status: block.data.initialStatus,
        locationId: block.data.initialLocationId
      })),
    resources: release.compiledArtifact.blocks
      .filter((block) => block.kind === "core.resource")
      .map((block) => ({
        id: block.id,
        unit: block.data.unit,
        value: block.data.initialValue,
        min: block.data.min,
        max: block.data.max
      })),
    items: [],
    terminal: null
  });
  if (!hasValidWorldStateReferences(state)) return frozen({ ok: false, code: "RELEASE_PREFLIGHT_FAILED" });

  return deepFreeze({
    ok: true,
    template: {
      sourceProjectId: release.projectId,
      release: {
        questId: release.questId,
        releaseId: release.releaseId,
        contentHash: release.compiledContentHash.toLowerCase()
      },
      initialState: state,
      executor,
      intentCatalog: action === null ? [] : createPaintIntentCatalog()
    }
  });
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}
function frozen<const T extends object>(value: T): Readonly<T> { return Object.freeze(value); }
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
