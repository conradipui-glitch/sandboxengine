import type { ContractSchemaVersion } from "./schema.js";

export const BLOCK_KINDS = [
  "core.location",
  "core.character",
  "core.resource"
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

export type Block = LocationBlock | CharacterBlock | ResourceBlock;

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
