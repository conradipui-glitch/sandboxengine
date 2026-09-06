import type { ActionBlock, Block, LocationBlock, ResourceBlock } from "@living-history/contracts";

const SCHEMA_VERSION = "1.0" as const;

export interface ResourceFormInput {
  readonly id: string;
  readonly title: string;
  readonly unit: string;
  readonly initialValue: number;
  readonly min: number;
  readonly max: number;
}

export interface PaintActionFormInput {
  readonly id: string;
  readonly title: string;
  readonly resourceId: string;
  readonly resourceUnitsPerUnit: number;
  readonly durationSecondsPerUnit: number;
  readonly allowPartial: boolean;
}

export function createInitialLocationBlock(id: string, title: string): LocationBlock {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    id,
    kind: "core.location",
    title,
    description: "",
    data: Object.freeze({})
  });
}

export function createResourceBlock(input: ResourceFormInput): ResourceBlock {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    id: input.id,
    kind: "core.resource",
    title: input.title,
    description: "",
    data: Object.freeze({
      unit: input.unit,
      initialValue: input.initialValue,
      min: input.min,
      max: input.max
    })
  });
}

export function createPaintActionBlock(input: PaintActionFormInput): ActionBlock {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    id: input.id,
    kind: "core.action",
    title: input.title,
    description: "",
    data: Object.freeze({
      actionType: "core.paint",
      resourceId: input.resourceId,
      resourceUnitsPerUnit: input.resourceUnitsPerUnit,
      durationSecondsPerUnit: input.durationSecondsPerUnit,
      allowPartial: input.allowPartial
    })
  });
}

export function replacePaintActionCost(action: ActionBlock, resourceUnitsPerUnit: number): ActionBlock {
  return createPaintActionBlock({
    id: action.id,
    title: action.title,
    resourceId: action.data.resourceId,
    resourceUnitsPerUnit,
    durationSecondsPerUnit: action.data.durationSecondsPerUnit,
    allowPartial: action.data.allowPartial
  });
}

export function resourceBlocks(blocks: readonly Block[]): readonly ResourceBlock[] {
  return blocks.filter((block): block is ResourceBlock => block.kind === "core.resource");
}

export function paintActionBlocks(blocks: readonly Block[]): readonly ActionBlock[] {
  return blocks.filter((block): block is ActionBlock => block.kind === "core.action");
}
