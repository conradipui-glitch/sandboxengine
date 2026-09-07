export const PLUGIN_MANIFEST_SCHEMA_VERSION = "1.0" as const;
export const ENGINE_PLUGIN_API_VERSION = "1.0.0" as const;

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const PUBLIC_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

const LIMITS = Object.freeze({
  pluginId: 120,
  publicId: 200,
  description: 2_000,
  schemas: 128,
  dependencies: 64,
  capabilities: 256,
  recipes: 128,
  backendIds: 256,
  uiComponents: 128
});

export interface PluginVersionRange {
  readonly minInclusive: string;
  readonly maxExclusive: string;
}

export interface PluginSchemaVersion {
  readonly schemaId: string;
  readonly version: string;
}

export interface PluginDependency {
  readonly pluginId: string;
  readonly versionRange: PluginVersionRange;
}

export interface PluginBackendManifest {
  readonly blockTypeIds: readonly string[];
  readonly actionTypeIds: readonly string[];
  readonly scheduledEventTypeIds: readonly string[];
  readonly effectTypeIds: readonly string[];
}

export interface PluginUiComponentManifest {
  readonly componentId: string;
  readonly propsSchemaId: string;
}

export interface PluginUiManifest {
  readonly components: readonly PluginUiComponentManifest[];
}

export interface PluginManifest {
  readonly schemaVersion: typeof PLUGIN_MANIFEST_SCHEMA_VERSION;
  readonly pluginId: string;
  readonly version: string;
  readonly engineApiRange: PluginVersionRange;
  readonly description: string;
  readonly schemaVersions: readonly PluginSchemaVersion[];
  readonly dependencies: readonly PluginDependency[];
  readonly capabilityIds: readonly string[];
  readonly recipeIds: readonly string[];
  readonly backend: PluginBackendManifest;
  readonly ui: PluginUiManifest | null;
}

export type PluginManifestValidationResult =
  | { readonly ok: true; readonly manifest: PluginManifest }
  | { readonly ok: false; readonly code: "INVALID_MANIFEST"; readonly reason: string };

export type PluginRegistryFailureCode =
  | "INVALID_ENGINE_API_VERSION"
  | "INVALID_MANIFEST"
  | "ENGINE_API_INCOMPATIBLE"
  | "DUPLICATE_PLUGIN_ID"
  | "MISSING_DEPENDENCY"
  | "DEPENDENCY_VERSION_MISMATCH"
  | "DEPENDENCY_CYCLE"
  | "GLOBAL_ID_COLLISION";

export interface PluginRegistryFailure {
  readonly ok: false;
  readonly code: PluginRegistryFailureCode;
  readonly pluginId?: string;
  readonly dependencyId?: string;
  readonly id?: string;
  readonly reason?: string;
}

export interface PluginOwnedId {
  readonly id: string;
  readonly pluginId: string;
  readonly category:
    | "schema"
    | "capability"
    | "recipe"
    | "block"
    | "action"
    | "scheduled_event"
    | "effect"
    | "ui_component"
    | "ui_props_schema";
}

export interface PluginRegistrySnapshot {
  readonly schemaVersion: typeof PLUGIN_MANIFEST_SCHEMA_VERSION;
  readonly enginePluginApiVersion: string;
  readonly pluginOrder: readonly string[];
  readonly plugins: readonly PluginManifest[];
  readonly ownedIds: readonly PluginOwnedId[];
}

export type PluginRegistryBuildResult =
  | { readonly ok: true; readonly registry: PluginRegistrySnapshot }
  | PluginRegistryFailure;

export interface PluginSchemaRequirement {
  readonly schemaId: string;
  readonly version: string;
}

export interface PluginReleaseRequirement {
  readonly pluginId: string;
  readonly versionRange: PluginVersionRange;
  readonly capabilityIds: readonly string[];
  readonly schemaVersions: readonly PluginSchemaRequirement[];
}

export interface PluginReleaseRequirements {
  readonly plugins: readonly PluginReleaseRequirement[];
}

export type PluginCompatibilityIssueCode =
  | "INVALID_REQUIREMENTS"
  | "MISSING_PLUGIN"
  | "PLUGIN_VERSION_INCOMPATIBLE"
  | "MISSING_CAPABILITY"
  | "MISSING_SCHEMA"
  | "SCHEMA_VERSION_INCOMPATIBLE";

export interface PluginCompatibilityIssue {
  readonly code: PluginCompatibilityIssueCode;
  readonly pluginId: string;
  readonly id?: string;
  readonly expected?: string;
  readonly actual?: string;
}

export type PluginCompatibilityResult =
  | { readonly compatible: true; readonly issues: readonly [] }
  | { readonly compatible: false; readonly issues: readonly PluginCompatibilityIssue[] };

export function validatePluginManifest(value: unknown): PluginManifestValidationResult {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    "schemaVersion",
    "pluginId",
    "version",
    "engineApiRange",
    "description",
    "schemaVersions",
    "dependencies",
    "capabilityIds",
    "recipeIds",
    "backend",
    "ui"
  ])) return invalid("manifest shape is invalid");

  if (value.schemaVersion !== PLUGIN_MANIFEST_SCHEMA_VERSION) return invalid("schemaVersion is unsupported");
  if (!isPluginId(value.pluginId)) return invalid("pluginId is invalid");
  if (!isVersion(value.version)) return invalid("plugin version is invalid");
  if (!isVersionRange(value.engineApiRange)) return invalid("engineApiRange is invalid");
  if (!isBoundedText(value.description, 1, LIMITS.description)) return invalid("description is invalid");
  if (!Array.isArray(value.schemaVersions) || value.schemaVersions.length > LIMITS.schemas) return invalid("schemaVersions is invalid");
  if (!Array.isArray(value.dependencies) || value.dependencies.length > LIMITS.dependencies) return invalid("dependencies is invalid");
  if (!isStringArray(value.capabilityIds, LIMITS.capabilities)) return invalid("capabilityIds is invalid");
  if (!isStringArray(value.recipeIds, LIMITS.recipes)) return invalid("recipeIds is invalid");
  if (!isPlainObject(value.backend) || !hasExactKeys(value.backend, [
    "blockTypeIds", "actionTypeIds", "scheduledEventTypeIds", "effectTypeIds"
  ])) return invalid("backend manifest is invalid");
  if (!isStringArray(value.backend.blockTypeIds, LIMITS.backendIds)
    || !isStringArray(value.backend.actionTypeIds, LIMITS.backendIds)
    || !isStringArray(value.backend.scheduledEventTypeIds, LIMITS.backendIds)
    || !isStringArray(value.backend.effectTypeIds, LIMITS.backendIds)) return invalid("backend ids are invalid");

  const schemaVersions: PluginSchemaVersion[] = [];
  for (const entry of value.schemaVersions) {
    if (!isPlainObject(entry) || !hasExactKeys(entry, ["schemaId", "version"])
      || typeof entry.schemaId !== "string" || !isVersion(entry.version)) return invalid("schema version entry is invalid");
    schemaVersions.push(Object.freeze({ schemaId: entry.schemaId, version: entry.version }));
  }

  const dependencies: PluginDependency[] = [];
  for (const entry of value.dependencies) {
    if (!isPlainObject(entry) || !hasExactKeys(entry, ["pluginId", "versionRange"])
      || !isPluginId(entry.pluginId) || entry.pluginId === value.pluginId
      || !isVersionRange(entry.versionRange)) return invalid("dependency entry is invalid");
    dependencies.push(Object.freeze({
      pluginId: entry.pluginId,
      versionRange: freezeRange(entry.versionRange)
    }));
  }

  let ui: PluginUiManifest | null = null;
  if (value.ui !== null) {
    if (!isPlainObject(value.ui) || !hasExactKeys(value.ui, ["components"])
      || !Array.isArray(value.ui.components) || value.ui.components.length > LIMITS.uiComponents) {
      return invalid("ui manifest is invalid");
    }
    const components: PluginUiComponentManifest[] = [];
    for (const component of value.ui.components) {
      if (!isPlainObject(component) || !hasExactKeys(component, ["componentId", "propsSchemaId"])
        || typeof component.componentId !== "string" || typeof component.propsSchemaId !== "string") {
        return invalid("ui component descriptor is invalid");
      }
      components.push(Object.freeze({ componentId: component.componentId, propsSchemaId: component.propsSchemaId }));
    }
    ui = Object.freeze({ components: Object.freeze(components) });
  }

  const manifest: PluginManifest = deepFreeze({
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    pluginId: value.pluginId,
    version: value.version,
    engineApiRange: freezeRange(value.engineApiRange),
    description: value.description,
    schemaVersions,
    dependencies,
    capabilityIds: [...value.capabilityIds],
    recipeIds: [...value.recipeIds],
    backend: {
      blockTypeIds: [...value.backend.blockTypeIds],
      actionTypeIds: [...value.backend.actionTypeIds],
      scheduledEventTypeIds: [...value.backend.scheduledEventTypeIds],
      effectTypeIds: [...value.backend.effectTypeIds]
    },
    ui
  });

  const dependencyIds = manifest.dependencies.map((entry) => entry.pluginId);
  if (!allUnique(dependencyIds)) return invalid("duplicate dependency id");

  const owned = collectOwnedIds(manifest);
  const ownedIds = owned.map((entry) => entry.id);
  if (!allUnique(ownedIds)) return invalid("duplicate plugin-owned id");
  for (const entry of owned) {
    if (!isNamespacedId(manifest.pluginId, entry.id)) return invalid(`plugin-owned id is not namespaced: ${entry.id}`);
  }

  return Object.freeze({ ok: true, manifest: normalizeManifest(manifest) });
}

export function buildPluginRegistry(
  manifests: readonly unknown[],
  enginePluginApiVersion = ENGINE_PLUGIN_API_VERSION
): PluginRegistryBuildResult {
  if (!isVersion(enginePluginApiVersion)) return failure("INVALID_ENGINE_API_VERSION");
  if (!Array.isArray(manifests) || manifests.length > 1_000) return failure("INVALID_MANIFEST", { reason: "manifest collection is invalid" });

  const byId = new Map<string, PluginManifest>();
  for (const raw of manifests) {
    const validated = validatePluginManifest(raw);
    if (!validated.ok) return failure("INVALID_MANIFEST", { reason: validated.reason });
    const manifest = validated.manifest;
    if (byId.has(manifest.pluginId)) return failure("DUPLICATE_PLUGIN_ID", { pluginId: manifest.pluginId });
    if (!versionInRange(enginePluginApiVersion, manifest.engineApiRange)) {
      return failure("ENGINE_API_INCOMPATIBLE", { pluginId: manifest.pluginId });
    }
    byId.set(manifest.pluginId, manifest);
  }

  for (const manifest of byId.values()) {
    for (const dependency of manifest.dependencies) {
      const installed = byId.get(dependency.pluginId);
      if (!installed) return failure("MISSING_DEPENDENCY", {
        pluginId: manifest.pluginId,
        dependencyId: dependency.pluginId
      });
      if (!versionInRange(installed.version, dependency.versionRange)) {
        return failure("DEPENDENCY_VERSION_MISMATCH", {
          pluginId: manifest.pluginId,
          dependencyId: dependency.pluginId
        });
      }
    }
  }

  const ownership = new Map<string, PluginOwnedId>();
  for (const manifest of byId.values()) {
    for (const entry of collectOwnedIds(manifest)) {
      const prior = ownership.get(entry.id);
      if (prior) return failure("GLOBAL_ID_COLLISION", { pluginId: manifest.pluginId, id: entry.id });
      ownership.set(entry.id, Object.freeze({ ...entry }));
    }
  }

  const order = topologicalOrder(byId);
  if (order === null) return failure("DEPENDENCY_CYCLE");

  const plugins = order.map((pluginId) => byId.get(pluginId)!);
  const ownedIds = [...ownership.values()].sort((left, right) =>
    left.id.localeCompare(right.id) || left.category.localeCompare(right.category) || left.pluginId.localeCompare(right.pluginId)
  );

  return Object.freeze({
    ok: true,
    registry: deepFreeze({
      schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
      enginePluginApiVersion,
      pluginOrder: order,
      plugins,
      ownedIds
    })
  });
}

export function checkPluginRequirements(
  registry: PluginRegistrySnapshot,
  requirements: PluginReleaseRequirements
): PluginCompatibilityResult {
  const issues: PluginCompatibilityIssue[] = [];
  if (!isRegistrySnapshot(registry) || !isReleaseRequirements(requirements)) {
    return Object.freeze({
      compatible: false,
      issues: Object.freeze([Object.freeze({ code: "INVALID_REQUIREMENTS", pluginId: "registry" })])
    });
  }

  const plugins = new Map(registry.plugins.map((manifest) => [manifest.pluginId, manifest]));
  for (const requirement of [...requirements.plugins].sort((a, b) => a.pluginId.localeCompare(b.pluginId))) {
    const installed = plugins.get(requirement.pluginId);
    if (!installed) {
      issues.push(Object.freeze({ code: "MISSING_PLUGIN", pluginId: requirement.pluginId }));
      continue;
    }
    if (!versionInRange(installed.version, requirement.versionRange)) {
      issues.push(Object.freeze({
        code: "PLUGIN_VERSION_INCOMPATIBLE",
        pluginId: requirement.pluginId,
        expected: rangeText(requirement.versionRange),
        actual: installed.version
      }));
    }

    const capabilities = new Set(installed.capabilityIds);
    for (const capabilityId of [...requirement.capabilityIds].sort()) {
      if (!capabilities.has(capabilityId)) {
        issues.push(Object.freeze({ code: "MISSING_CAPABILITY", pluginId: requirement.pluginId, id: capabilityId }));
      }
    }

    const schemaVersions = new Map(installed.schemaVersions.map((entry) => [entry.schemaId, entry.version]));
    for (const schema of [...requirement.schemaVersions].sort((a, b) => a.schemaId.localeCompare(b.schemaId))) {
      const actual = schemaVersions.get(schema.schemaId);
      if (actual === undefined) {
        issues.push(Object.freeze({ code: "MISSING_SCHEMA", pluginId: requirement.pluginId, id: schema.schemaId }));
      } else if (actual !== schema.version) {
        issues.push(Object.freeze({
          code: "SCHEMA_VERSION_INCOMPATIBLE",
          pluginId: requirement.pluginId,
          id: schema.schemaId,
          expected: schema.version,
          actual
        }));
      }
    }
  }

  return issues.length === 0
    ? Object.freeze({ compatible: true, issues: Object.freeze([]) as readonly [] })
    : Object.freeze({ compatible: false, issues: Object.freeze(issues) });
}

export function versionInRange(version: string, range: PluginVersionRange): boolean {
  const parsed = parseVersion(version);
  const min = parseVersion(range.minInclusive);
  const max = parseVersion(range.maxExclusive);
  if (!parsed || !min || !max || compareVersion(min, max) >= 0) return false;
  return compareVersion(parsed, min) >= 0 && compareVersion(parsed, max) < 0;
}

function normalizeManifest(manifest: PluginManifest): PluginManifest {
  return deepFreeze({
    ...manifest,
    engineApiRange: freezeRange(manifest.engineApiRange),
    schemaVersions: [...manifest.schemaVersions]
      .sort((a, b) => a.schemaId.localeCompare(b.schemaId))
      .map((entry) => Object.freeze({ ...entry })),
    dependencies: [...manifest.dependencies]
      .sort((a, b) => a.pluginId.localeCompare(b.pluginId))
      .map((entry) => Object.freeze({ pluginId: entry.pluginId, versionRange: freezeRange(entry.versionRange) })),
    capabilityIds: Object.freeze([...manifest.capabilityIds].sort()),
    recipeIds: Object.freeze([...manifest.recipeIds].sort()),
    backend: Object.freeze({
      blockTypeIds: Object.freeze([...manifest.backend.blockTypeIds].sort()),
      actionTypeIds: Object.freeze([...manifest.backend.actionTypeIds].sort()),
      scheduledEventTypeIds: Object.freeze([...manifest.backend.scheduledEventTypeIds].sort()),
      effectTypeIds: Object.freeze([...manifest.backend.effectTypeIds].sort())
    }),
    ui: manifest.ui === null ? null : Object.freeze({
      components: Object.freeze([...manifest.ui.components]
        .sort((a, b) => a.componentId.localeCompare(b.componentId))
        .map((entry) => Object.freeze({ ...entry })))
    })
  });
}

function collectOwnedIds(manifest: PluginManifest): PluginOwnedId[] {
  const result: PluginOwnedId[] = [];
  const add = (category: PluginOwnedId["category"], id: string) => result.push({ category, id, pluginId: manifest.pluginId });
  for (const entry of manifest.schemaVersions) add("schema", entry.schemaId);
  for (const id of manifest.capabilityIds) add("capability", id);
  for (const id of manifest.recipeIds) add("recipe", id);
  for (const id of manifest.backend.blockTypeIds) add("block", id);
  for (const id of manifest.backend.actionTypeIds) add("action", id);
  for (const id of manifest.backend.scheduledEventTypeIds) add("scheduled_event", id);
  for (const id of manifest.backend.effectTypeIds) add("effect", id);
  for (const component of manifest.ui?.components ?? []) {
    add("ui_component", component.componentId);
    add("ui_props_schema", component.propsSchemaId);
  }
  return result;
}

function topologicalOrder(byId: ReadonlyMap<string, PluginManifest>): readonly string[] | null {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const pluginId of byId.keys()) {
    indegree.set(pluginId, 0);
    dependents.set(pluginId, []);
  }
  for (const manifest of byId.values()) {
    indegree.set(manifest.pluginId, manifest.dependencies.length);
    for (const dependency of manifest.dependencies) dependents.get(dependency.pluginId)!.push(manifest.pluginId);
  }
  for (const values of dependents.values()) values.sort();

  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const pluginId = ready.shift()!;
    order.push(pluginId);
    for (const dependent of dependents.get(pluginId) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) insertSorted(ready, dependent);
    }
  }
  return order.length === byId.size ? Object.freeze(order) : null;
}

function isRegistrySnapshot(value: unknown): value is PluginRegistrySnapshot {
  if (!isPlainObject(value)
    || value.schemaVersion !== PLUGIN_MANIFEST_SCHEMA_VERSION
    || !isVersion(value.enginePluginApiVersion)
    || !Array.isArray(value.pluginOrder)
    || !Array.isArray(value.plugins)
    || !Array.isArray(value.ownedIds)) return false;
  return value.plugins.every((entry) => validatePluginManifest(entry).ok);
}

function isReleaseRequirements(value: unknown): value is PluginReleaseRequirements {
  if (!isPlainObject(value) || !hasExactKeys(value, ["plugins"]) || !Array.isArray(value.plugins) || value.plugins.length > 1_000) return false;
  const ids = new Set<string>();
  for (const requirement of value.plugins) {
    if (!isPlainObject(requirement) || !hasExactKeys(requirement, ["pluginId", "versionRange", "capabilityIds", "schemaVersions"])
      || !isPluginId(requirement.pluginId) || ids.has(requirement.pluginId) || !isVersionRange(requirement.versionRange)
      || !isStringArray(requirement.capabilityIds, LIMITS.capabilities)
      || !Array.isArray(requirement.schemaVersions) || requirement.schemaVersions.length > LIMITS.schemas) return false;
    ids.add(requirement.pluginId);
    if (!allUnique(requirement.capabilityIds)) return false;
    const schemas = new Set<string>();
    for (const schema of requirement.schemaVersions) {
      if (!isPlainObject(schema) || !hasExactKeys(schema, ["schemaId", "version"])
        || typeof schema.schemaId !== "string" || !isVersion(schema.version) || schemas.has(schema.schemaId)) return false;
      schemas.add(schema.schemaId);
    }
  }
  return true;
}

function isVersionRange(value: unknown): value is PluginVersionRange {
  if (!isPlainObject(value) || !hasExactKeys(value, ["minInclusive", "maxExclusive"])
    || !isVersion(value.minInclusive) || !isVersion(value.maxExclusive)) return false;
  const min = parseVersion(value.minInclusive)!;
  const max = parseVersion(value.maxExclusive)!;
  return compareVersion(min, max) < 0;
}

function freezeRange(range: PluginVersionRange): PluginVersionRange {
  return Object.freeze({ minInclusive: range.minInclusive, maxExclusive: range.maxExclusive });
}

function parseVersion(value: unknown): readonly [number, number, number] | null {
  if (typeof value !== "string") return null;
  const match = VERSION_PATTERN.exec(value);
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareVersion(left: readonly [number, number, number], right: readonly [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    const delta = left[index]! - right[index]!;
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

function isVersion(value: unknown): value is string {
  return parseVersion(value) !== null;
}

function isPluginId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= LIMITS.pluginId && PLUGIN_ID_PATTERN.test(value);
}

function isNamespacedId(pluginId: string, value: string): boolean {
  return value.length >= pluginId.length + 2
    && value.length <= LIMITS.publicId
    && PUBLIC_ID_PATTERN.test(value)
    && value.startsWith(`${pluginId}.`);
}

function isStringArray(value: unknown, maxItems: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((entry) => typeof entry === "string");
}

function allUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function isBoundedText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function insertSorted(values: string[], value: string): void {
  let index = 0;
  while (index < values.length && values[index]!.localeCompare(value) < 0) index += 1;
  values.splice(index, 0, value);
}

function rangeText(range: PluginVersionRange): string {
  return `[${range.minInclusive},${range.maxExclusive})`;
}

function invalid(reason: string): PluginManifestValidationResult {
  return Object.freeze({ ok: false, code: "INVALID_MANIFEST", reason });
}

function failure(
  code: PluginRegistryFailureCode,
  details: Omit<PluginRegistryFailure, "ok" | "code"> = {}
): PluginRegistryFailure {
  return Object.freeze({ ok: false, code, ...details });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
