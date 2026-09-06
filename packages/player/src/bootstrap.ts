import {
  CONTRACT_SCHEMA_VERSION,
  hasValidWorldStateReferences,
  isBlock,
  type ActionBlock,
  type Block,
  type WorldState
} from "@living-history/contracts";
import type { PinnedReleaseIdentity } from "@living-history/runtime";

export interface FrozenPlaytestSnapshotSource {
  readonly questId: string;
  readonly title: string;
  readonly entryLocationId: string;
  readonly contentHash: string;
  readonly blocks: readonly Block[];
}

export interface FrozenPlaytestBootstrapSource {
  readonly playtestId: string;
  readonly questId: string;
  readonly contentHash: string;
  readonly compiledContentHash: string;
  readonly snapshot: FrozenPlaytestSnapshotSource;
}

export interface PlayerPaintActionDefinition {
  readonly id: string;
  readonly actionType: "core.paint";
  readonly resourceId: string;
  readonly resourceUnitsPerUnit: number;
  readonly durationSecondsPerUnit: number;
  readonly allowPartial: boolean;
}

export interface PlayerRuntimeTemplate {
  readonly templateId: string;
  readonly title: string;
  readonly playtestId: string;
  readonly compiledContentHash: string;
  readonly release: PinnedReleaseIdentity;
  readonly initialState: WorldState;
  readonly paintActions: readonly PlayerPaintActionDefinition[];
}

export type BootstrapFrozenPlaytestResult =
  | { readonly ok: true; readonly template: PlayerRuntimeTemplate }
  | { readonly ok: false; readonly code: "invalid_playtest" | "unsupported_playtest" };

/**
 * Converts one already-frozen authoring snapshot into the bounded B05 gameplay
 * bootstrap. It never reads a current draft and never computes action effects.
 */
export function bootstrapFrozenPlaytest(
  source: FrozenPlaytestBootstrapSource
): BootstrapFrozenPlaytestResult {
  if (!isRuntimeId(source.playtestId)
    || !isRuntimeId(source.questId)
    || !isHash(source.contentHash)
    || !isHash(source.compiledContentHash)
    || source.snapshot.questId !== source.questId
    || source.snapshot.contentHash !== source.contentHash
    || typeof source.snapshot.title !== "string"
    || source.snapshot.title.length < 1
    || source.snapshot.title.length > 200
    || !isRuntimeId(source.snapshot.entryLocationId)
    || !Array.isArray(source.snapshot.blocks)
  ) {
    return failure("invalid_playtest");
  }

  const blocks = source.snapshot.blocks;
  if (blocks.some((block) => !isBlock(block))) return failure("invalid_playtest");

  const ids = new Set<string>();
  for (const block of blocks) {
    if (ids.has(block.id)) return failure("invalid_playtest");
    ids.add(block.id);
  }

  const locations = blocks
    .filter((block) => block.kind === "core.location")
    .map((block) => Object.freeze({ id: block.id }));
  const locationIds = new Set(locations.map((location) => location.id));
  if (!locationIds.has(source.snapshot.entryLocationId)) return failure("invalid_playtest");

  const entities = blocks
    .filter((block) => block.kind === "core.character")
    .map((block) => Object.freeze({
      id: block.id,
      type: "character",
      status: block.data.initialStatus,
      locationId: block.data.initialLocationId
    }));
  if (entities.some((entity) => entity.locationId !== null && !locationIds.has(entity.locationId))) {
    return failure("invalid_playtest");
  }

  const resources = blocks
    .filter((block) => block.kind === "core.resource")
    .map((block) => Object.freeze({
      id: block.id,
      unit: block.data.unit,
      value: block.data.initialValue,
      min: block.data.min,
      max: block.data.max
    }));
  const resourceIds = new Set(resources.map((resource) => resource.id));

  const actionBlocks = blocks.filter((block): block is ActionBlock => block.kind === "core.action");
  if (actionBlocks.length < 1) return failure("unsupported_playtest");
  if (actionBlocks.some((block) => !resourceIds.has(block.data.resourceId))) return failure("invalid_playtest");

  const paintActions = actionBlocks.map((block) => Object.freeze({
    id: block.id,
    actionType: "core.paint" as const,
    resourceId: block.data.resourceId,
    resourceUnitsPerUnit: block.data.resourceUnitsPerUnit,
    durationSecondsPerUnit: block.data.durationSecondsPerUnit,
    allowPartial: block.data.allowPartial
  }));

  const initialState: WorldState = deepFreeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    revision: 0,
    clock: { elapsedSeconds: 0 },
    locations,
    entities,
    resources,
    items: [],
    terminal: null
  });
  if (!hasValidWorldStateReferences(initialState)) return failure("invalid_playtest");

  const release: PinnedReleaseIdentity = Object.freeze({
    questId: source.questId,
    releaseId: `playtest-${source.playtestId}`,
    contentHash: source.contentHash
  });

  return Object.freeze({
    ok: true,
    template: deepFreeze({
      templateId: `playtest-${source.playtestId}`,
      title: source.snapshot.title,
      playtestId: source.playtestId,
      compiledContentHash: source.compiledContentHash,
      release,
      initialState,
      paintActions
    })
  });
}

function isRuntimeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function failure(code: "invalid_playtest" | "unsupported_playtest"): BootstrapFrozenPlaytestResult {
  return Object.freeze({ ok: false, code });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
