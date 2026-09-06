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

export async function buildGeneratedDocs(root) {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const registry = JSON.parse(await readFile(resolve(root, "packages/contracts/registry/endpoints.json"), "utf8"));
  const schemaDirectory = resolve(root, "packages/contracts/schemas/v1");
  const schemaFiles = (await readdir(schemaDirectory))
    .filter((name) => name.endsWith(".schema.json"))
    .sort();

  const schemas = [];
  let blockKinds = [];
  let gameplayEffectTypes = [];
  let contractsSchemaVersion = null;
  for (const file of schemaFiles) {
    const schema = JSON.parse(await readFile(resolve(schemaDirectory, file), "utf8"));
    const name = file.replace(/\.schema\.json$/, "");
    schemas.push({
      name,
      file: `packages/contracts/schemas/v1/${file}`,
      id: schema.$id
    });
    const version = schema?.properties?.schemaVersion?.const
      ?? schema?.oneOf?.[0]?.properties?.schemaVersion?.const;
    if (version !== undefined) {
      if (contractsSchemaVersion === null) contractsSchemaVersion = version;
      if (contractsSchemaVersion !== version) {
        throw new Error(`Schema version mismatch in ${file}`);
      }
    }
    if (name === "block") blockKinds = [...schema.properties.kind.enum].sort();
    if (name === "gameplay-effect") {
      gameplayEffectTypes = schema.oneOf
        .map((variant) => variant?.properties?.type?.const)
        .filter((value) => typeof value === "string")
        .sort();
    }
  }

  if (contractsSchemaVersion === null) throw new Error("No contract schema version found");

  const availableOperations = registry.operations
    .filter((operation) => operation.readiness === "available")
    .map(({ id, method, path, summary }) => ({ id, method, path, summary }));

  const schemaIndex = {
    contractsSchemaVersion,
    schemas
  };
  const capabilities = {
    contractsSchemaVersion,
    blockKinds,
    gameplayEffectTypes,
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
    schemas
  }));
  const compatibility = {
    engineVersion: packageJson.version,
    contractsSchemaVersion,
    registryVersion: registry.registryVersion,
    registryHash,
    availableOperationCount: availableOperations.length
  };
  const skill = buildSkill({
    engineVersion: packageJson.version,
    contractsSchemaVersion,
    blockKinds,
    gameplayEffectTypes,
    availableOperations
  });

  return new Map([
    ["docs/agent/SKILL.md", skill],
    ["docs/agent/api.openapi.json", formatJson(openapi)],
    ["docs/agent/capabilities.json", formatJson(capabilities)],
    ["docs/agent/compatibility.json", formatJson(compatibility)],
    ["docs/agent/schema-index.json", formatJson(schemaIndex)]
  ]);
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
        "200": { description: "Successful response" }
      }
    };
  }
  return paths;
}

function buildSkill({ engineVersion, contractsSchemaVersion, blockKinds, gameplayEffectTypes, availableOperations }) {
  const operationLines = availableOperations.length === 0
    ? "- Нет доступных HTTP-операций: Runtime/Control API ещё не реализованы."
    : availableOperations.map((operation) => `- \`${operation.method} ${operation.path}\` — ${operation.summary}`).join("\n");
  const blockLines = blockKinds.map((kind) => `- \`${kind}\``).join("\n");
  const effectLines = gameplayEffectTypes.length === 0
    ? "- Нет исполняемых gameplay effects."
    : gameplayEffectTypes.map((type) => `- \`${type}\``).join("\n");
  return `# Living History Engine — agent contract\n\n` +
    `Generated file. Do not edit by hand.\n\n` +
    `- Engine version: \`${engineVersion}\`\n` +
    `- Contracts schema version: \`${contractsSchemaVersion}\`\n` +
    `- Canonical schemas: [schema-index.json](schema-index.json)\n` +
    `- Machine capabilities: [capabilities.json](capabilities.json)\n` +
    `- OpenAPI of implemented operations only: [api.openapi.json](api.openapi.json)\n\n` +
    `## Available block kinds\n\n${blockLines}\n\n` +
    `## Available gameplay effects\n\n${effectLines}\n\n` +
    `## Available HTTP operations\n\n${operationLines}\n\n` +
    `Planned registry entries are intentionally excluded from the available list. ` +
    `Read ../../AGENTS.md, ../STATUS.md and ../HANDOFF.md before changing code.\n`;
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
