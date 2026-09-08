import type { Block } from "@living-history/contracts";
import type { DraftSnapshot } from "./types.js";

export const MAX_AUTHOR_CONTEXT_SELECTED_BLOCKS = 32;
export const MAX_AUTHOR_CONTEXT_INCLUDED_BLOCKS = 64;
export const MAX_AUTHOR_CONTEXT_CAPABILITY_IDS = 512;

export const CORE_AUTHOR_CONTEXT_BLOCK_KINDS = Object.freeze([
  "core.action",
  "core.character",
  "core.location",
  "core.resource"
] as const);

export interface AuthorContextCapabilityCatalog {
  readonly coreBlockKinds: readonly string[];
  readonly pluginCapabilityIds: readonly string[];
  readonly pluginBlockTypeIds: readonly string[];
  readonly pluginActionTypeIds: readonly string[];
}

export interface AuthorContextBundle {
  readonly projectId: string;
  readonly questId: string;
  readonly draftRevision: number;
  readonly draftContentHash: string;
  readonly title: string;
  readonly entryLocationId: string;
  readonly selectedBlockIds: readonly string[];
  readonly dependencyBlockIds: readonly string[];
  readonly includedBlockIds: readonly string[];
  readonly blocks: readonly Block[];
  readonly capabilities: AuthorContextCapabilityCatalog;
}

export type BuildAuthorContextBundleResult =
  | { readonly kind: "built"; readonly bundle: AuthorContextBundle }
  | {
      readonly kind: "invalid_request";
      readonly code:
        | "invalid_selection"
        | "selected_block_not_found"
        | "duplicate_stored_block_id"
        | "invalid_typed_dependency"
        | "missing_typed_dependency"
        | "context_too_large"
        | "invalid_capability_catalog";
      readonly blockId?: string;
    };

export const CORE_ONLY_AUTHOR_CONTEXT_CAPABILITY_CATALOG: AuthorContextCapabilityCatalog = deepFreeze({
  coreBlockKinds: [...CORE_AUTHOR_CONTEXT_BLOCK_KINDS],
  pluginCapabilityIds: [],
  pluginBlockTypeIds: [],
  pluginActionTypeIds: []
});

/**
 * Build one deterministic authoring context bundle from explicit selected blocks.
 * Dependency expansion is intentionally one-hop and outgoing-only:
 * character -> initial location, action -> resource. Inbound references and
 * descriptive strings never expand context, so a small selection cannot silently
 * become the whole project.
 */
export function buildAuthorContextBundle(
  snapshot: DraftSnapshot,
  selectedBlockIds: readonly string[],
  capabilityCatalog: AuthorContextCapabilityCatalog = CORE_ONLY_AUTHOR_CONTEXT_CAPABILITY_CATALOG
): BuildAuthorContextBundleResult {
  if (!Array.isArray(selectedBlockIds)
    || selectedBlockIds.length < 1
    || selectedBlockIds.length > MAX_AUTHOR_CONTEXT_SELECTED_BLOCKS
    || !selectedBlockIds.every(isId)
    || new Set(selectedBlockIds).size !== selectedBlockIds.length) {
    return frozen({ kind: "invalid_request", code: "invalid_selection" });
  }

  const byId = new Map<string, Block>();
  for (const block of snapshot.blocks) {
    if (!isId(block.id)) return frozen({ kind: "invalid_request", code: "duplicate_stored_block_id", blockId: String(block.id) });
    if (byId.has(block.id)) return frozen({ kind: "invalid_request", code: "duplicate_stored_block_id", blockId: block.id });
    byId.set(block.id, block);
  }

  const selected = [...selectedBlockIds].sort();
  for (const blockId of selected) {
    if (!byId.has(blockId)) return frozen({ kind: "invalid_request", code: "selected_block_not_found", blockId });
  }

  const dependencyIds = new Set<string>();
  for (const blockId of selected) {
    const block = byId.get(blockId)!;
    const dependencyId = outgoingTypedDependency(block);
    if (dependencyId === null) continue;
    if (!isId(dependencyId)) return frozen({ kind: "invalid_request", code: "invalid_typed_dependency", blockId });
    if (!byId.has(dependencyId)) return frozen({ kind: "invalid_request", code: "missing_typed_dependency", blockId: dependencyId });
    if (!selected.includes(dependencyId)) dependencyIds.add(dependencyId);
  }

  const dependencies = [...dependencyIds].sort();
  const included = [...new Set([...selected, ...dependencies])].sort();
  if (included.length > MAX_AUTHOR_CONTEXT_INCLUDED_BLOCKS) {
    return frozen({ kind: "invalid_request", code: "context_too_large" });
  }

  const capabilities = normalizeCapabilityCatalog(capabilityCatalog);
  if (!capabilities) return frozen({ kind: "invalid_request", code: "invalid_capability_catalog" });

  const blocks = included.map((blockId) => cloneJson(byId.get(blockId)!));
  return frozen({
    kind: "built",
    bundle: deepFreeze({
      projectId: snapshot.projectId,
      questId: snapshot.questId,
      draftRevision: snapshot.draftRevision,
      draftContentHash: snapshot.contentHash,
      title: snapshot.title,
      entryLocationId: snapshot.entryLocationId,
      selectedBlockIds: selected,
      dependencyBlockIds: dependencies,
      includedBlockIds: included,
      blocks,
      capabilities
    })
  });
}

function outgoingTypedDependency(block: Block): string | null {
  if (block.kind === "core.character") return block.data.initialLocationId;
  if (block.kind === "core.action") return block.data.resourceId;
  return null;
}

function normalizeCapabilityCatalog(value: AuthorContextCapabilityCatalog): AuthorContextCapabilityCatalog | null {
  if (value === null || typeof value !== "object") return null;
  const coreBlockKinds = normalizeIds(value.coreBlockKinds);
  const pluginCapabilityIds = normalizeIds(value.pluginCapabilityIds);
  const pluginBlockTypeIds = normalizeIds(value.pluginBlockTypeIds);
  const pluginActionTypeIds = normalizeIds(value.pluginActionTypeIds);
  if (!coreBlockKinds || !pluginCapabilityIds || !pluginBlockTypeIds || !pluginActionTypeIds) return null;
  if (coreBlockKinds.length !== CORE_AUTHOR_CONTEXT_BLOCK_KINDS.length
    || !CORE_AUTHOR_CONTEXT_BLOCK_KINDS.every((kind) => coreBlockKinds.includes(kind))) return null;
  return deepFreeze({ coreBlockKinds, pluginCapabilityIds, pluginBlockTypeIds, pluginActionTypeIds });
}

function normalizeIds(value: readonly string[]): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_AUTHOR_CONTEXT_CAPABILITY_IDS || !value.every(isId)) return null;
  return Object.freeze([...new Set(value)].sort());
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function frozen<const T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
