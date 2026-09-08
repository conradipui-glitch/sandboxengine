// @ts-ignore — Node 24.19.0 provides node:crypto; repository intentionally has no @types/node dependency yet.
import { createHash } from "node:crypto";
// @ts-ignore — Node 24.19.0 provides node:fs; repository intentionally has no @types/node dependency yet.
import { readFileSync } from "node:fs";
// @ts-ignore — Node 24.19.0 provides node:path; repository intentionally has no @types/node dependency yet.
import { join } from "node:path";
// @ts-ignore — Node 24.19.0 provides node:url; repository intentionally has no @types/node dependency yet.
import { fileURLToPath } from "node:url";
import { canonicalStringify } from "@living-history/core";

export const AGENT_KIT_ENGINE_VERSION_HEADER = "x-lh-engine-version";
export const AGENT_KIT_REGISTRY_HASH_HEADER = "x-lh-registry-hash";
export const AGENT_KIT_DOCS_HASH_HEADER = "x-lh-docs-hash";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const AGENT_KIT_PATHS = Object.freeze([
  "docs/agent/SKILL.md",
  "docs/agent/api.openapi.json",
  "docs/agent/capabilities.json",
  "docs/agent/compatibility.json",
  "docs/agent/schema-index.json",
  "docs/agent/recipes/quest-authoring.md",
  "docs/agent/recipes/scene-presentation.md",
  "docs/agent/recipes/plugin-extension.md",
  "docs/agent/recipes/ui-provider-extension.md",
  "docs/agent/recipes/migration-validation.md"
] as const);
const DOC_HASH_PATHS = Object.freeze([
  "docs/agent/SKILL.md",
  "docs/agent/api.openapi.json",
  "docs/agent/capabilities.json",
  "docs/agent/schema-index.json",
  "docs/agent/recipes/quest-authoring.md",
  "docs/agent/recipes/scene-presentation.md",
  "docs/agent/recipes/plugin-extension.md",
  "docs/agent/recipes/ui-provider-extension.md",
  "docs/agent/recipes/migration-validation.md"
] as const);

export interface InstalledAgentKitIdentity {
  readonly engineVersion: string;
  readonly contractsSchemaVersion: string;
  readonly presentationSchemaVersion: string;
  readonly pluginManifestSchemaVersion: string;
  readonly enginePluginApiVersion: string;
  readonly registryVersion: string;
  readonly registryHash: string;
  readonly pluginRegistryVersion: string;
  readonly pluginRegistryHash: string;
  readonly apiHash: string;
  readonly docsHash: string;
}

export interface InstalledAgentKitFile {
  readonly path: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly content: string;
}

export interface InstalledAgentKit {
  readonly identity: InstalledAgentKitIdentity;
  readonly files: readonly InstalledAgentKitFile[];
}

export function loadInstalledAgentKit(): InstalledAgentKit {
  const contents = new Map<string, string>();
  for (const path of AGENT_KIT_PATHS) contents.set(path, readFileSync(join(ROOT, path), "utf8"));

  let compatibility: Record<string, unknown>;
  try {
    compatibility = JSON.parse(contents.get("docs/agent/compatibility.json")!) as Record<string, unknown>;
  } catch {
    throw new Error("installed agent kit compatibility is not valid JSON");
  }
  if (!isCompatibility(compatibility)) throw new Error("installed agent kit compatibility has invalid shape");

  const apiHash = sha256(contents.get("docs/agent/api.openapi.json")!);
  const docsHash = computeDocsHash(contents);
  if (compatibility.apiHash !== apiHash || compatibility.docsHash !== docsHash) {
    throw new Error("installed agent kit generated docs do not match compatibility hashes");
  }

  const identity: InstalledAgentKitIdentity = deepFreeze({
    engineVersion: compatibility.engineVersion,
    contractsSchemaVersion: compatibility.contractsSchemaVersion,
    presentationSchemaVersion: compatibility.presentationSchemaVersion,
    pluginManifestSchemaVersion: compatibility.pluginManifestSchemaVersion,
    enginePluginApiVersion: compatibility.enginePluginApiVersion,
    registryVersion: compatibility.registryVersion,
    registryHash: compatibility.registryHash,
    pluginRegistryVersion: compatibility.pluginRegistryVersion,
    pluginRegistryHash: compatibility.pluginRegistryHash,
    apiHash: compatibility.apiHash,
    docsHash: compatibility.docsHash
  });
  const files = AGENT_KIT_PATHS.map((path) => deepFreeze({
    path,
    mediaType: path.endsWith(".md") ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8",
    sha256: sha256(contents.get(path)!),
    content: contents.get(path)!
  }));
  return deepFreeze({ identity, files });
}

export function agentKitHandshakeMatches(
  requestHeaders: Readonly<Record<string, string | undefined>>,
  identity: InstalledAgentKitIdentity
): boolean {
  return requestHeaders[AGENT_KIT_ENGINE_VERSION_HEADER] === identity.engineVersion
    && requestHeaders[AGENT_KIT_REGISTRY_HASH_HEADER] === identity.registryHash
    && requestHeaders[AGENT_KIT_DOCS_HASH_HEADER] === identity.docsHash;
}

function computeDocsHash(contents: ReadonlyMap<string, string>): string {
  const manifest = DOC_HASH_PATHS.map((path) => ({ path, sha256: sha256(contents.get(path)!) }));
  return sha256(canonicalStringify(manifest));
}

function isCompatibility(value: Record<string, unknown>): value is Record<string, string> & {
  engineVersion: string;
  contractsSchemaVersion: string;
  presentationSchemaVersion: string;
  pluginManifestSchemaVersion: string;
  enginePluginApiVersion: string;
  registryVersion: string;
  registryHash: string;
  pluginRegistryVersion: string;
  pluginRegistryHash: string;
  apiHash: string;
  docsHash: string;
} {
  for (const key of [
    "engineVersion", "contractsSchemaVersion", "presentationSchemaVersion", "pluginManifestSchemaVersion",
    "enginePluginApiVersion", "registryVersion", "pluginRegistryVersion"
  ]) {
    if (!isBoundedString(value[key], 1, 100)) return false;
  }
  for (const key of ["registryHash", "pluginRegistryHash", "apiHash", "docsHash"]) {
    if (!isSha256(value[key])) return false;
  }
  return true;
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
