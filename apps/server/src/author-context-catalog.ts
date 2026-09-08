import {
  CORE_AUTHOR_CONTEXT_BLOCK_KINDS,
  type AuthorContextCapabilityCatalog
} from "@living-history/control";
import type { PluginRegistrySnapshot } from "@living-history/plugins";

export function buildInstalledAuthorContextCapabilityCatalog(
  registry: PluginRegistrySnapshot | null
): AuthorContextCapabilityCatalog {
  const capabilityIds: string[] = [];
  const blockTypeIds: string[] = [];
  const actionTypeIds: string[] = [];
  for (const plugin of registry?.plugins ?? []) {
    capabilityIds.push(...plugin.capabilityIds);
    blockTypeIds.push(...plugin.backend.blockTypeIds);
    actionTypeIds.push(...plugin.backend.actionTypeIds);
  }
  return deepFreeze({
    coreBlockKinds: [...CORE_AUTHOR_CONTEXT_BLOCK_KINDS],
    pluginCapabilityIds: [...new Set(capabilityIds)].sort(),
    pluginBlockTypeIds: [...new Set(blockTypeIds)].sort(),
    pluginActionTypeIds: [...new Set(actionTypeIds)].sort()
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
