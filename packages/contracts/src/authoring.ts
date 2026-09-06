import { CONTRACT_SCHEMA_VERSION, type ContractSchemaVersion } from "./schema.js";

export const BLOCK_KINDS = [
  "core.location",
  "core.character",
  "core.resource",
  "core.action"
] as const;

export type BlockKind = (typeof BLOCK_KINDS)[number];

export interface BlockBase<K extends BlockKind, D> {
  readonly schemaVersion: ContractSchemaVersion;
  readonly id: string;
  readonly kind: K;
  readonly title: string;
  readonly description: string;
  readonly data: D;
}

export type LocationBlock = BlockBase<"core.location", Readonly<Record<string, never>>>;

export interface CharacterBlockData {
  readonly initialLocationId: string | null;
  readonly initialStatus: string;
}

export type CharacterBlock = BlockBase<"core.character", CharacterBlockData>;

export interface ResourceBlockData {
  readonly unit: string;
  readonly initialValue: number;
  readonly min: number;
  readonly max: number;
}

export type ResourceBlock = BlockBase<"core.resource", ResourceBlockData>;

export interface PaintActionBlockData {
  readonly actionType: "core.paint";
  readonly resourceId: string;
  readonly resourceUnitsPerUnit: number;
  readonly durationSecondsPerUnit: number;
  readonly allowPartial: boolean;
}

export type ActionBlock = BlockBase<"core.action", PaintActionBlockData>;

export type Block = LocationBlock | CharacterBlock | ResourceBlock | ActionBlock;

export function isBlock(value: unknown): value is Block {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "id", "kind", "title", "description", "data"])) return false;
  if (value.schemaVersion !== CONTRACT_SCHEMA_VERSION || !isId(value.id)) return false;
  if (typeof value.title !== "string" || value.title.length < 1 || value.title.length > 200) return false;
  if (typeof value.description !== "string" || value.description.length > 2_000) return false;
  if (!isRecord(value.data)) return false;

  if (value.kind === "core.location") return hasExactKeys(value.data, []);

  if (value.kind === "core.character") {
    if (!hasExactKeys(value.data, ["initialLocationId", "initialStatus"])) return false;
    return (value.data.initialLocationId === null || isId(value.data.initialLocationId))
      && typeof value.data.initialStatus === "string"
      && value.data.initialStatus.length >= 1
      && value.data.initialStatus.length <= 100;
  }

  if (value.kind === "core.resource") {
    if (!hasExactKeys(value.data, ["unit", "initialValue", "min", "max"])) return false;
    return typeof value.data.unit === "string"
      && value.data.unit.length >= 1
      && value.data.unit.length <= 100
      && isSafeInteger(value.data.initialValue)
      && isSafeInteger(value.data.min)
      && isSafeInteger(value.data.max)
      && value.data.min <= value.data.max
      && value.data.initialValue >= value.data.min
      && value.data.initialValue <= value.data.max;
  }

  if (value.kind === "core.action") {
    if (!hasExactKeys(value.data, ["actionType", "resourceId", "resourceUnitsPerUnit", "durationSecondsPerUnit", "allowPartial"])) return false;
    return value.data.actionType === "core.paint"
      && isId(value.data.resourceId)
      && isPositiveSafeInteger(value.data.resourceUnitsPerUnit)
      && isNonNegativeSafeInteger(value.data.durationSecondsPerUnit)
      && typeof value.data.allowPartial === "boolean";
  }

  return false;
}

export interface QuestReleaseCompatibility {
  readonly contractsSchemaVersion: ContractSchemaVersion;
}

/**
 * Minimal immutable release manifest for B01-03. Content hashing and plugin
 * locks are added by the compile slice, not guessed here.
 */
export interface QuestRelease {
  readonly schemaVersion: ContractSchemaVersion;
  readonly questId: string;
  readonly releaseId: string;
  readonly title: string;
  readonly compatibility: QuestReleaseCompatibility;
  readonly blockIds: readonly string[];
  readonly entryLocationId: string;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface TextIntentSource {
  readonly kind: "text";
  readonly text: string;
}

export interface ActionIntentSource {
  readonly kind: "action";
  readonly actionType: string;
  readonly args: Readonly<Record<string, JsonValue>>;
}

export type IntentSource = TextIntentSource | ActionIntentSource;

/**
 * Result of understanding input, before Core checks availability or computes
 * duration/effects. It intentionally cannot carry statePatch or effect data.
 */
export interface ResolvedIntent {
  readonly schemaVersion: ContractSchemaVersion;
  readonly actionType: string;
  readonly participantIds: readonly string[];
  readonly targetIds: readonly string[];
  readonly args: Readonly<Record<string, JsonValue>>;
  readonly sourceInput: IntentSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 1;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}
