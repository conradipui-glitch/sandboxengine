import { type ActionBlock, type WorldState } from "@living-history/contracts";
import type { PinnedReleaseIdentity } from "@living-history/runtime";
import {
  buildFrozenWorldState,
  deepFreeze,
  isHash,
  isRuntimeId,
  type FrozenPlaytestBootstrapSource,
  type FrozenPlaytestSnapshotSource
} from "./frozen-playtest.js";

export type { FrozenPlaytestBootstrapSource, FrozenPlaytestSnapshotSource } from "./frozen-playtest.js";

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
 *
 * Отказ `unsupported_playtest` здесь означает ровно одно: в снимке нет ни
 * одного блока-действия, то есть это не блочный playtest. Сюжетную миссию
 * (документ сцен/выборов) играет отдельная ветка запуска — `resolveStory…` в
 * apps/player, — а не этот блочный bootstrap.
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

  const world = buildFrozenWorldState(source.snapshot);
  if (!world.ok) return failure("invalid_playtest");
  const initialState = world.state;
  const resourceIds = world.resourceIds;

  const actionBlocks = source.snapshot.blocks.filter((block): block is ActionBlock => block.kind === "core.action");
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

function failure(code: "invalid_playtest" | "unsupported_playtest"): BootstrapFrozenPlaytestResult {
  return Object.freeze({ ok: false, code });
}
