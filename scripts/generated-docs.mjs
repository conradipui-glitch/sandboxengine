import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const AGENT_RECIPE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "quest-authoring",
    title: "Quest authoring",
    goal: "Prepare bounded typed quest draft changes through canonical AuthoringProposal preview/apply semantics.",
    requiredPaths: Object.freeze([
      "packages/contracts/schemas/v1/block.schema.json",
      "packages/control/src/authoring-proposal.ts"
    ]),
    verificationScripts: Object.freeze(["test:contracts", "test:control", "test:server"]),
    invariants: Object.freeze([
      "Use typed Control draft changes only and bind them to the exact base revision/content hash.",
      "Preview and validate on a copy before Apply; stale bases never authorize overwrite.",
      "Quest authoring does not publish releases, change access roles, or mutate Runtime/player state."
    ])
  }),
  Object.freeze({
    id: "scene-presentation",
    title: "Scene presentation",
    goal: "Change presentation data without widening it into gameplay authority.",
    requiredPaths: Object.freeze([
      "packages/contracts/schemas/v2/scene-frame.schema.json",
      "packages/contracts/schemas/v2/presentation-plan.schema.json",
      "apps/player/presentation-renderer.js"
    ]),
    verificationScripts: Object.freeze(["test:contracts", "test:player", "check:boundaries"]),
    invariants: Object.freeze([
      "Presentation references exact allowed assets/actors and remains reload-safe.",
      "Presentation commands cannot mutate gameplay state or execute arbitrary code.",
      "Renderer changes must preserve the existing Player/Runtime/Core authority boundary."
    ])
  }),
  Object.freeze({
    id: "plugin-extension",
    title: "Plugin extension",
    goal: "Prepare a manifest-bound plugin extension that stays inside installed plugin contracts.",
    requiredPaths: Object.freeze([
      "packages/plugins/schemas/v1/plugin-manifest.schema.json",
      "packages/plugins/registry/installed.json"
    ]),
    verificationScripts: Object.freeze(["test:plugins", "test:core", "test:server", "check:boundaries"]),
    invariants: Object.freeze([
      "Plugin-owned IDs and capabilities must be declared by a compatible installed manifest.",
      "No executable URL, raw HTML, secret, or repository/deployment authority is granted by a plugin recipe.",
      "Core remains generic; plugin output still passes existing canonical Core validation gates."
    ])
  }),
  Object.freeze({
    id: "ui-provider-extension",
    title: "UI/provider extension",
    goal: "Extend Studio UI or AI provider composition without moving credentials or authority into the browser.",
    requiredPaths: Object.freeze([
      "apps/studio/src/api.ts",
      "packages/ai/src/provider.ts",
      "packages/ai/src/agent-backend.ts"
    ]),
    verificationScripts: Object.freeze(["test:ai", "test:studio", "check:boundaries"]),
    invariants: Object.freeze([
      "Browser state is presentation/transport only and never becomes authorization or revision authority.",
      "Provider credentials stay server-side and provider/AgentBackend code cannot write drafts or gameplay state directly.",
      "This recipe grants no shell, filesystem, repository mutation, deployment, or secret-read capability."
    ])
  }),
  Object.freeze({
    id: "migration-validation",
    title: "Migration validation",
    goal: "Validate compatibility-sensitive changes without claiming an automatic migration implementation.",
    requiredPaths: Object.freeze([
      "packages/contracts/schemas/v1/block.schema.json",
      "packages/contracts/schemas/v2/scene-frame.schema.json",
      "scripts/generated-docs.mjs"
    ]),
    verificationScripts: Object.freeze(["typecheck", "test:contracts", "docs:check", "verify"]),
    invariants: Object.freeze([
      "Treat compatibility/hash mismatch as explicit evidence; never silently rewrite authored history or immutable releases.",
      "Generated docs and schemas must remain deterministic and current before compatibility is accepted.",
      "This is validation guidance only; it does not claim an automatic migration, publish, rollback, or deployment tool."
    ])
  })
]);

export const AGENT_RECIPE_PATHS = Object.freeze(
  AGENT_RECIPE_DEFINITIONS.map((recipe) => `docs/agent/recipes/${recipe.id}.md`)
);

export const GENERATED_DOC_PATHS = [
  "docs/agent/SKILL.md",
  "docs/agent/api.openapi.json",
  "docs/agent/capabilities.json",
  "docs/agent/compatibility.json",
  "docs/agent/schema-index.json",
  ...AGENT_RECIPE_PATHS
];

export const GENERATED_DOC_HASH_PATHS = Object.freeze([
  "docs/agent/SKILL.md",
  "docs/agent/api.openapi.json",
  "docs/agent/capabilities.json",
  "docs/agent/schema-index.json",
  ...AGENT_RECIPE_PATHS
]);

const SAFE_AGENT_RECIPE_SCRIPTS = new Set([
  "typecheck",
  "test:contracts",
  "test:plugins",
  "test:core",
  "test:ai",
  "test:control",
  "test:server",
  "test:studio",
  "test:player",
  "check:boundaries",
  "docs:check",
  "verify"
]);

export async function buildGeneratedDocs(root) {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  await validateAgentRecipeDefinitions(root, packageJson);
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
  for (const recipe of AGENT_RECIPE_DEFINITIONS) {
    rendered.set(`docs/agent/recipes/${recipe.id}.md`, buildAgentRecipe(recipe));
  }
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
    ["docs/agent/schema-index.json", rendered.get("docs/agent/schema-index.json")],
    ...AGENT_RECIPE_PATHS.map((path) => [path, rendered.get(path)])
  ]);
}

export async function validateAgentRecipeDefinitions(root, packageJson, definitions = AGENT_RECIPE_DEFINITIONS) {
  if (!packageJson || typeof packageJson !== "object" || !packageJson.scripts || typeof packageJson.scripts !== "object") {
    throw new Error("Agent recipe validation requires package.json scripts");
  }
  const ids = new Set();
  for (const recipe of definitions) {
    if (!recipe || typeof recipe !== "object" || !/^[a-z][a-z0-9-]{1,63}$/.test(recipe.id ?? "")) {
      throw new Error("Invalid agent recipe id");
    }
    if (ids.has(recipe.id)) throw new Error(`Duplicate agent recipe id: ${recipe.id}`);
    ids.add(recipe.id);
    if (typeof recipe.title !== "string" || recipe.title.length < 1 || recipe.title.length > 120) {
      throw new Error(`Invalid agent recipe title: ${recipe.id}`);
    }
    if (typeof recipe.goal !== "string" || recipe.goal.length < 1 || recipe.goal.length > 500) {
      throw new Error(`Invalid agent recipe goal: ${recipe.id}`);
    }
    if (!Array.isArray(recipe.requiredPaths) || recipe.requiredPaths.length < 1 || recipe.requiredPaths.length > 16) {
      throw new Error(`Invalid requiredPaths for agent recipe: ${recipe.id}`);
    }
    for (const path of recipe.requiredPaths) {
      if (typeof path !== "string" || path.length < 1 || path.length > 240 || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
        throw new Error(`Unsafe agent recipe path: ${recipe.id}`);
      }
      try {
        await access(resolve(root, path));
      } catch {
        throw new Error(`Missing agent recipe path: ${recipe.id}: ${path}`);
      }
    }
    if (!Array.isArray(recipe.verificationScripts) || recipe.verificationScripts.length < 1 || recipe.verificationScripts.length > 12) {
      throw new Error(`Invalid verificationScripts for agent recipe: ${recipe.id}`);
    }
    for (const script of recipe.verificationScripts) {
      if (!SAFE_AGENT_RECIPE_SCRIPTS.has(script)) throw new Error(`Unsafe agent recipe verification script: ${recipe.id}: ${script}`);
      if (typeof packageJson.scripts[script] !== "string" || packageJson.scripts[script].length < 1) {
        throw new Error(`Missing npm script for agent recipe: ${recipe.id}: ${script}`);
      }
    }
    if (!Array.isArray(recipe.invariants) || recipe.invariants.length < 1 || recipe.invariants.length > 12
      || recipe.invariants.some((item) => typeof item !== "string" || item.length < 1 || item.length > 500)) {
      throw new Error(`Invalid invariants for agent recipe: ${recipe.id}`);
    }
  }
  return true;
}

function buildAgentRecipe(recipe) {
  const paths = recipe.requiredPaths.map((path) => `- \`${path}\``).join("\n");
  const commands = recipe.verificationScripts.map((script) => `- \`npm run ${script}\``).join("\n");
  const invariants = recipe.invariants.map((item) => `- ${item}`).join("\n");
  return `# ${recipe.title}

${recipe.goal}

> This recipe is generated documentation/task material only. It does not grant tools, permissions, shell access, repository mutation, deployment authority, secret access, or gameplay authority.

## Required repository paths

${paths}

## Verification commands

These commands are evidence instructions for an authorized external workflow; this agent kit does not itself grant command execution.

${commands}

## Invariants

${invariants}
`;
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
