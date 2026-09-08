import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const GENERATED_DOC_PATHS = [
  "docs/agent/SKILL.md",
  "docs/agent/api.openapi.json",
  "docs/agent/capabilities.json",
  "docs/agent/compatibility.json",
  "docs/agent/schema-index.json"
];

export const GENERATED_DOC_HASH_PATHS = Object.freeze([
  "docs/agent/SKILL.md",
  "docs/agent/api.openapi.json",
  "docs/agent/capabilities.json",
  "docs/agent/schema-index.json"
]);

export async function buildGeneratedDocs(root) {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const registry = JSON.parse(await readFile(resolve(root, "packages/contracts/registry/endpoints.json"), "utf8"));
  const pluginRegistry = JSON.parse(await readFile(resolve(root, "packages/plugins/registry/installed.json"), "utf8"));
  const pluginManifestSchema = JSON.parse(await readFile(resolve(root, "packages/plugins/schemas/v1/plugin-manifest.schema.json"), "utf8"));
  validatePluginRegistryMetadata(pluginRegistry, pluginManifestSchema);

  const schemaDirectories = ["v1", "v2"];
  const schemaEntries = [];
  for (const directory of schemaDirectories) {
    const absolute = resolve(root, `packages/contracts/schemas/${directory}`);
    let files;
    try {
      files = await readdir(absolute);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const file of files.filter((name) => name.endsWith(".schema.json")).sort()) {
      schemaEntries.push({ directory, file });
    }
  }

  const schemas = [];
  let blockKinds = [];
  let gameplayEffectTypes = [];
  let conditionTypes = [];
  let socialActTypes = [];
  const scheduledEventKinds = [];
  const scheduledTaskKinds = [];
  let actionTypes = [];
  let presentationCommandTypes = [];
  let contractsSchemaVersion = null;
  let presentationSchemaVersion = null;

  for (const { directory, file } of schemaEntries) {
    const schema = JSON.parse(await readFile(resolve(root, `packages/contracts/schemas/${directory}/${file}`), "utf8"));
    const name = file.replace(/\.schema\.json$/, "");
    const version = schemaVersionOf(schema);
    schemas.push({
      name,
      version,
      file: `packages/contracts/schemas/${directory}/${file}`,
      id: schema.$id
    });

    if (directory === "v1" && version !== null) {
      if (contractsSchemaVersion === null) contractsSchemaVersion = version;
      if (contractsSchemaVersion !== version) throw new Error(`Core schema version mismatch in ${file}`);
    }
    if (directory === "v2" && version !== null) {
      if (presentationSchemaVersion === null) presentationSchemaVersion = version;
      if (presentationSchemaVersion !== version) throw new Error(`Presentation schema version mismatch in ${file}`);
    }

    if (directory === "v1" && name === "block") blockKinds = [...schema.properties.kind.enum].sort();
    if (directory === "v1" && name === "gameplay-effect") {
      gameplayEffectTypes = schema.oneOf
        .map((variant) => variant?.properties?.type?.const)
        .filter((value) => typeof value === "string")
        .sort();
    }
    if (directory === "v1" && name === "condition") {
      conditionTypes = schema.oneOf
        .map((variant) => variant?.properties?.type?.const)
        .filter((value) => typeof value === "string")
        .sort();
    }
    if (directory === "v1" && name === "social-act") socialActTypes = ["permission", "request", "response"];
    if (directory === "v1" && ["scheduled-event", "scheduled-effect-event", "scheduled-terminal-event"].includes(name)) {
      const kind = schema?.properties?.kind?.const;
      if (typeof kind === "string") scheduledEventKinds.push(kind);
    }
    if (directory === "v1" && name === "scheduled-task") {
      const kind = schema?.properties?.kind?.const;
      if (typeof kind === "string") scheduledTaskKinds.push(kind);
    }
    if (directory === "v1" && name === "calculated-action") {
      actionTypes = schema.oneOf
        .map((variant) => variant?.properties?.actionType?.const)
        .filter((value) => typeof value === "string")
        .sort();
    }
    if (directory === "v2" && name === "presentation-plan") {
      presentationCommandTypes = presentationCommandsOf(schema);
    }
  }
  scheduledEventKinds.sort();
  scheduledTaskKinds.sort();
  schemas.sort((a, b) => a.file.localeCompare(b.file));

  if (contractsSchemaVersion === null) throw new Error("No core contract schema version found");
  if (presentationSchemaVersion === null) throw new Error("No presentation schema version found");

  const availableOperations = registry.operations
    .filter((operation) => operation.readiness === "available")
    .map(({ id, method, path, summary, successStatus = 200 }) => ({
      id,
      method,
      path,
      summary,
      successStatus
    }));

  const installedPlugins = [...pluginRegistry.plugins]
    .map((plugin) => normalizeInstalledPluginMetadata(plugin))
    .sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  const installedPluginCapabilityIds = [...new Set(installedPlugins.flatMap((plugin) => plugin.capabilityIds))].sort();
  const installedPluginBlockTypeIds = [...new Set(installedPlugins.flatMap((plugin) => plugin.blockTypeIds))].sort();
  const installedPluginActionTypeIds = [...new Set(installedPlugins.flatMap((plugin) => plugin.actionTypeIds))].sort();
  const installedPluginRecipeIds = [...new Set(installedPlugins.flatMap((plugin) => plugin.recipeIds))].sort();
  const pluginSchemas = [{
    name: "plugin-manifest",
    version: pluginRegistry.pluginManifestSchemaVersion,
    file: "packages/plugins/schemas/v1/plugin-manifest.schema.json",
    id: pluginManifestSchema.$id
  }];

  const schemaIndex = {
    contractsSchemaVersion,
    presentationSchemaVersion,
    pluginManifestSchemaVersion: pluginRegistry.pluginManifestSchemaVersion,
    enginePluginApiVersion: pluginRegistry.enginePluginApiVersion,
    schemas,
    pluginSchemas
  };
  const capabilities = {
    contractsSchemaVersion,
    presentationSchemaVersion,
    pluginManifestSchemaVersion: pluginRegistry.pluginManifestSchemaVersion,
    enginePluginApiVersion: pluginRegistry.enginePluginApiVersion,
    installedPlugins,
    installedPluginCapabilityIds,
    installedPluginBlockTypeIds,
    installedPluginActionTypeIds,
    installedPluginRecipeIds,
    blockKinds,
    gameplayEffectTypes,
    conditionTypes,
    socialActTypes,
    scheduledEventKinds,
    scheduledTaskKinds,
    actionTypes,
    presentationCommandTypes,
    operations: availableOperations
  };
  const openapi = {
    openapi: "3.1.1",
    info: {
      title: "Living History Engine API",
      version: packageJson.version
    },
    paths: buildOpenApiPaths(availableOperations)
  };
  const registryHash = sha256(canonicalStringify({
    registryVersion: registry.registryVersion,
    operations: registry.operations,
    blockKinds,
    gameplayEffectTypes,
    conditionTypes,
    socialActTypes,
    scheduledEventKinds,
    scheduledTaskKinds,
    actionTypes,
    presentationCommandTypes,
    schemas
  }));
  const pluginRegistryHash = sha256(canonicalStringify(pluginRegistry));
  const skill = buildSkill({
    engineVersion: packageJson.version,
    contractsSchemaVersion,
    presentationSchemaVersion,
    pluginManifestSchemaVersion: pluginRegistry.pluginManifestSchemaVersion,
    enginePluginApiVersion: pluginRegistry.enginePluginApiVersion,
    installedPlugins,
    blockKinds,
    gameplayEffectTypes,
    conditionTypes,
    socialActTypes,
    scheduledEventKinds,
    scheduledTaskKinds,
    actionTypes,
    presentationCommandTypes,
    availableOperations
  });

  const rendered = new Map([
    ["docs/agent/SKILL.md", skill],
    ["docs/agent/api.openapi.json", formatJson(openapi)],
    ["docs/agent/capabilities.json", formatJson(capabilities)],
    ["docs/agent/schema-index.json", formatJson(schemaIndex)]
  ]);
  const apiHash = sha256(rendered.get("docs/agent/api.openapi.json"));
  const docsHash = computeGeneratedDocsHash(rendered);
  const compatibility = {
    engineVersion: packageJson.version,
    contractsSchemaVersion,
    presentationSchemaVersion,
    pluginManifestSchemaVersion: pluginRegistry.pluginManifestSchemaVersion,
    enginePluginApiVersion: pluginRegistry.enginePluginApiVersion,
    registryVersion: registry.registryVersion,
    registryHash,
    pluginRegistryVersion: pluginRegistry.registryVersion,
    pluginRegistryHash,
    apiHash,
    docsHash,
    installedPluginCount: installedPlugins.length,
    availableOperationCount: availableOperations.length
  };

  return new Map([
    ["docs/agent/SKILL.md", rendered.get("docs/agent/SKILL.md")],
    ["docs/agent/api.openapi.json", rendered.get("docs/agent/api.openapi.json")],
    ["docs/agent/capabilities.json", rendered.get("docs/agent/capabilities.json")],
    ["docs/agent/compatibility.json", formatJson(compatibility)],
    ["docs/agent/schema-index.json", rendered.get("docs/agent/schema-index.json")]
  ]);
}

export function computeGeneratedDocsHash(generated) {
  const manifest = GENERATED_DOC_HASH_PATHS.map((path) => {
    const contents = generated.get(path);
    if (typeof contents !== "string") throw new Error(`Missing generated doc for hash: ${path}`);
    return { path, sha256: sha256(contents) };
  });
  return sha256(canonicalStringify(manifest));
}

export async function writeGeneratedDocs(root) {
  const generated = await buildGeneratedDocs(root);
  for (const [relative, contents] of generated) {
    const path = resolve(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
  }
  return generated;
}

export async function readCommittedGeneratedDocs(root) {
  const actual = new Map();
  for (const relative of GENERATED_DOC_PATHS) {
    try {
      actual.set(relative, await readFile(resolve(root, relative), "utf8"));
    } catch {
      actual.set(relative, null);
    }
  }
  return actual;
}

export function findStaleGeneratedPaths(expected, actual) {
  const stale = [];
  for (const [relative, contents] of expected) {
    if (actual.get(relative) !== contents) stale.push(relative);
  }
  return stale.sort();
}

function buildOpenApiPaths(operations) {
  const paths = {};
  for (const operation of operations) {
    const method = operation.method.toLowerCase();
    paths[operation.path] ??= {};
    paths[operation.path][method] = {
      operationId: operation.id.replace(/[^A-Za-z0-9_]/g, "_"),
      summary: operation.summary,
      responses: {
        [String(operation.successStatus)]: { description: "Successful response" }
      }
    };
  }
  return paths;
}

function buildSkill({ engineVersion, contractsSchemaVersion, presentationSchemaVersion, pluginManifestSchemaVersion, enginePluginApiVersion, installedPlugins, blockKinds, gameplayEffectTypes, conditionTypes, socialActTypes, scheduledEventKinds, scheduledTaskKinds, actionTypes, presentationCommandTypes, availableOperations }) {
  const operationLines = availableOperations.length === 0
    ? "- Нет доступных HTTP-операций: Runtime/Control API ещё не реализованы."
    : availableOperations.map((operation) => `- \`${operation.method} ${operation.path}\` — ${operation.summary}`).join("\n");
  const blockLines = blockKinds.map((kind) => `- \`${kind}\``).join("\n");
  const effectLines = gameplayEffectTypes.length === 0
    ? "- Нет исполняемых gameplay effects."
    : gameplayEffectTypes.map((type) => `- \`${type}\``).join("\n");
  const conditionLines = conditionTypes.length === 0
    ? "- Нет декларативных conditions."
    : conditionTypes.map((type) => `- \`${type}\``).join("\n");
  const socialLines = socialActTypes.length === 0
    ? "- Нет social act contracts."
    : socialActTypes.map((type) => `- \`${type}\``).join("\n");
  const scheduledEventLines = scheduledEventKinds.length === 0
    ? "- Нет scheduler event contracts."
    : scheduledEventKinds.map((kind) => `- \`${kind}\``).join("\n");
  const scheduledTaskLines = scheduledTaskKinds.length === 0
    ? "- Нет scheduler task contracts."
    : scheduledTaskKinds.map((kind) => `- \`${kind}\``).join("\n");
  const actionLines = actionTypes.length === 0
    ? "- Нет рассчитанных action types."
    : actionTypes.map((type) => `- \`${type}\``).join("\n");
  const presentationLines = presentationCommandTypes.length === 0
    ? "- Нет presentation commands."
    : presentationCommandTypes.map((type) => `- \`${type}\``).join("\n");
  const pluginLines = installedPlugins.length === 0
    ? "- Нет установленных trusted plugins в этой сборке."
    : installedPlugins.map((plugin) => {
        const capabilities = plugin.capabilityIds.join(", ") || "без capability IDs";
        const actions = plugin.actionTypeIds.join(", ") || "без action IDs";
        const recipes = plugin.recipeIds.join(", ") || "без recipe IDs";
        return `- \`${plugin.pluginId}@${plugin.version}\` — capabilities: ${capabilities}; actions: ${actions}; recipes: ${recipes}`;
      }).join("\n");
  return `# Living History Engine — agent contract\n\n` +
    `Generated file. Do not edit by hand.\n\n` +
    `- Engine version: \`${engineVersion}\`\n` +
    `- Core contracts schema version: \`${contractsSchemaVersion}\`\n` +
    `- Presentation schema version: \`${presentationSchemaVersion}\`\n` +
    `- Plugin manifest schema version: \`${pluginManifestSchemaVersion}\`\n` +
    `- Engine plugin API version: \`${enginePluginApiVersion}\`\n` +
    `- Canonical schemas: [schema-index.json](schema-index.json)\n` +
    `- Machine capabilities: [capabilities.json](capabilities.json)\n` +
    `- OpenAPI of implemented operations only: [api.openapi.json](api.openapi.json)\n\n` +
    `## Installed trusted plugins\n\n${pluginLines}\n\n` +
    `## Available block kinds\n\n${blockLines}\n\n` +
    `## Available gameplay effects\n\n${effectLines}\n\n` +
    `## Available conditions\n\n${conditionLines}\n\n` +
    `## Available social acts\n\n${socialLines}\n\n` +
    `## Available scheduled events\n\n${scheduledEventLines}\n\n` +
    `## Available scheduled tasks\n\n${scheduledTaskLines}\n\n` +
    `## Available calculated actions\n\n${actionLines}\n\n` +
    `## Available presentation commands\n\n${presentationLines}\n\n` +
    `## Available HTTP operations\n\n${operationLines}\n\n` +
    `Trusted plugin metadata is build-time registry data only; this Skill does not imply dynamic plugin loading or resolver execution. ` +
    `Planned registry entries are intentionally excluded from the available list. ` +
    `Read ../../AGENTS.md, ../STATUS.md and ../HANDOFF.md before changing code.\n`;
}

function schemaVersionOf(schema) {
  const version = schema?.properties?.schemaVersion?.const
    ?? schema?.oneOf?.[0]?.properties?.schemaVersion?.const
    ?? schema?.$defs?.request?.properties?.schemaVersion?.const;
  return typeof version === "string" ? version : null;
}

function presentationCommandsOf(schema) {
  const refs = schema?.$defs?.node?.oneOf ?? [];
  const values = refs
    .map((entry) => typeof entry?.$ref === "string" ? entry.$ref.split("/").at(-1) : null)
    .map((name) => name ? schema?.$defs?.[name]?.properties?.type?.const : null)
    .filter((value) => typeof value === "string" && value !== "sequence" && value !== "parallel");
  return [...new Set(values)].sort();
}

function validatePluginRegistryMetadata(registry, manifestSchema) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) throw new Error("Invalid installed plugin registry");
  const keys = Object.keys(registry).sort();
  const expected = ["enginePluginApiVersion", "pluginManifestSchemaVersion", "plugins", "registryVersion"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("Installed plugin registry shape mismatch");
  if (registry.registryVersion !== "1.0") throw new Error("Unsupported installed plugin registry version");
  if (typeof registry.pluginManifestSchemaVersion !== "string" || typeof registry.enginePluginApiVersion !== "string" || !Array.isArray(registry.plugins)) {
    throw new Error("Installed plugin registry metadata invalid");
  }
  if (manifestSchema?.properties?.schemaVersion?.const !== registry.pluginManifestSchemaVersion) {
    throw new Error("Plugin manifest schema version mismatch");
  }
  if (typeof manifestSchema?.$id !== "string") throw new Error("Plugin manifest schema id missing");
}

function normalizeInstalledPluginMetadata(plugin) {
  if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)
    || typeof plugin.pluginId !== "string"
    || typeof plugin.version !== "string"
    || !Array.isArray(plugin.capabilityIds)
    || !Array.isArray(plugin.schemaVersions)
    || !Array.isArray(plugin.recipeIds)
    || !plugin.backend
    || typeof plugin.backend !== "object"
    || Array.isArray(plugin.backend)
    || !Array.isArray(plugin.backend.blockTypeIds)
    || !Array.isArray(plugin.backend.actionTypeIds)) {
    throw new Error("Invalid installed plugin metadata entry");
  }
  return {
    pluginId: plugin.pluginId,
    version: plugin.version,
    capabilityIds: [...plugin.capabilityIds].sort(),
    schemaVersions: [...plugin.schemaVersions]
      .map((entry) => ({ schemaId: entry.schemaId, version: entry.version }))
      .sort((a, b) => a.schemaId.localeCompare(b.schemaId)),
    blockTypeIds: [...plugin.backend.blockTypeIds].sort(),
    actionTypeIds: [...plugin.backend.actionTypeIds].sort(),
    recipeIds: [...plugin.recipeIds].sort()
  };
}

function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(",")}}`;
}
