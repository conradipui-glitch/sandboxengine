import type { Block } from "@living-history/contracts";
import type { DraftChange } from "@living-history/control";

const SCHEMA_VERSION = "1.0" as const;

export type InspectorBlockKind = "location" | "character" | "resource" | "action";

export type InspectorPatch = Readonly<Partial<{
  title: string;
  description: string;
  initialLocationId: string | null;
  initialStatus: string;
  unit: string;
  initialValue: number;
  min: number;
  max: number;
  resourceId: string;
  resourceUnitsPerUnit: number;
  durationSecondsPerUnit: number;
  allowPartial: boolean;
}>>;

export interface LocationBlockInput {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

export interface CharacterBlockInput extends LocationBlockInput {
  readonly initialLocationId: string | null;
  readonly initialStatus: string;
}

export interface ResourceBlockInput extends LocationBlockInput {
  readonly unit: string;
  readonly initialValue: number;
  readonly min: number;
  readonly max: number;
}

export interface ActionBlockInput extends LocationBlockInput {
  readonly resourceId: string;
  readonly resourceUnitsPerUnit: number;
  readonly durationSecondsPerUnit: number;
  readonly allowPartial: boolean;
}

export type InspectorBlockInput =
  | { readonly kind: "location"; readonly input: LocationBlockInput }
  | { readonly kind: "character"; readonly input: CharacterBlockInput }
  | { readonly kind: "resource"; readonly input: ResourceBlockInput }
  | { readonly kind: "action"; readonly input: ActionBlockInput };

/** Build the only supported block edit operation: a full block.replace. */
export function replaceBlockWithPatch(block: Block, patch: InspectorPatch): Extract<DraftChange, { kind: "block.replace" }> {
  const dataPatch: Record<string, unknown> = {};
  if (block.kind === "core.character") {
    if (patch.initialLocationId !== undefined) dataPatch.initialLocationId = patch.initialLocationId;
    if (patch.initialStatus !== undefined) dataPatch.initialStatus = patch.initialStatus;
  } else if (block.kind === "core.resource") {
    if (patch.unit !== undefined) dataPatch.unit = patch.unit;
    if (patch.initialValue !== undefined) dataPatch.initialValue = patch.initialValue;
    if (patch.min !== undefined) dataPatch.min = patch.min;
    if (patch.max !== undefined) dataPatch.max = patch.max;
  } else if (block.kind === "core.action") {
    if (patch.resourceId !== undefined) dataPatch.resourceId = patch.resourceId;
    if (patch.resourceUnitsPerUnit !== undefined) dataPatch.resourceUnitsPerUnit = patch.resourceUnitsPerUnit;
    if (patch.durationSecondsPerUnit !== undefined) dataPatch.durationSecondsPerUnit = patch.durationSecondsPerUnit;
    if (patch.allowPartial !== undefined) dataPatch.allowPartial = patch.allowPartial;
  }
  const nextBlock = {
    ...block,
    title: patch.title ?? block.title,
    description: patch.description ?? block.description,
    data: { ...block.data, ...dataPatch }
  } as Block;
  return { kind: "block.replace", blockId: block.id, block: nextBlock };
}

export function createBlockForKind(kind: "location", input: LocationBlockInput): Block;
export function createBlockForKind(kind: "character", input: CharacterBlockInput): Block;
export function createBlockForKind(kind: "resource", input: ResourceBlockInput): Block;
export function createBlockForKind(kind: "action", input: ActionBlockInput): Block;
export function createBlockForKind(kind: InspectorBlockKind, input: LocationBlockInput | CharacterBlockInput | ResourceBlockInput | ActionBlockInput): Block {
  requireId(input.id);
  requireText(input.title, "title");
  if (input.description.length > 2_000) throw new Error("description must be at most 2000 characters");
  if (kind === "location") {
    return { schemaVersion: SCHEMA_VERSION, id: input.id, kind: "core.location", title: input.title, description: input.description, data: {} };
  }
  if (kind === "character") {
    const character = input as CharacterBlockInput;
    requireText(character.initialStatus, "initialStatus");
    if (character.initialLocationId !== null) requireId(character.initialLocationId);
    return {
      schemaVersion: SCHEMA_VERSION,
      id: character.id,
      kind: "core.character",
      title: character.title,
      description: character.description,
      data: { initialLocationId: character.initialLocationId, initialStatus: character.initialStatus }
    };
  }
  if (kind === "resource") {
    const resource = input as ResourceBlockInput;
    requireText(resource.unit, "unit");
    requireSafeInteger(resource.initialValue, "initialValue");
    requireSafeInteger(resource.min, "min");
    requireSafeInteger(resource.max, "max");
    if (resource.min > resource.max || resource.initialValue < resource.min || resource.initialValue > resource.max) {
      throw new Error("initialValue must be between min and max");
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      id: resource.id,
      kind: "core.resource",
      title: resource.title,
      description: resource.description,
      data: { unit: resource.unit, initialValue: resource.initialValue, min: resource.min, max: resource.max }
    };
  }
  const action = input as ActionBlockInput;
  requireId(action.resourceId);
  requireSafeInteger(action.resourceUnitsPerUnit, "resourceUnitsPerUnit");
  requireSafeInteger(action.durationSecondsPerUnit, "durationSecondsPerUnit");
  if (action.resourceUnitsPerUnit < 1 || action.durationSecondsPerUnit < 0) {
    throw new Error("action costs must be positive and duration non-negative");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    id: action.id,
    kind: "core.action",
    title: action.title,
    description: action.description,
    data: {
      actionType: "core.paint",
      resourceId: action.resourceId,
      resourceUnitsPerUnit: action.resourceUnitsPerUnit,
      durationSecondsPerUnit: action.durationSecondsPerUnit,
      allowPartial: action.allowPartial
    }
  };
}

function requireText(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required`);
}

function requireId(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) throw new Error("invalid block id or resource id");
}

function requireSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${field} must be a safe integer`);
}
