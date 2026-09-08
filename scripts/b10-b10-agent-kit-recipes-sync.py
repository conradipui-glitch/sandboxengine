from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: anchor {label!r}: expected 1, found {count}")
    p.write_text(text.replace(old, new, 1))


# 1) Generated docs own five checked recipes; every recipe participates in docsHash.
replace_once(
    "scripts/generated-docs.mjs",
    '''import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
''',
    '''import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
''',
    "fs access import"
)

replace_once(
    "scripts/generated-docs.mjs",
    '''export const GENERATED_DOC_PATHS = [
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
''',
    '''export const AGENT_RECIPE_DEFINITIONS = Object.freeze([
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
    verificationScripts: Object.freeze(["typecheck", "fixtures:check", "docs:check", "verify"]),
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
  "fixtures:check",
  "docs:check",
  "verify"
]);
''',
    "recipe definitions and generated paths"
)

replace_once(
    "scripts/generated-docs.mjs",
    '''  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const registry = JSON.parse(await readFile(resolve(root, "packages/contracts/registry/endpoints.json"), "utf8"));
''',
    '''  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  await validateAgentRecipeDefinitions(root, packageJson);
  const registry = JSON.parse(await readFile(resolve(root, "packages/contracts/registry/endpoints.json"), "utf8"));
''',
    "validate recipes before generation"
)

replace_once(
    "scripts/generated-docs.mjs",
    '''  const rendered = new Map([
    ["docs/agent/SKILL.md", skill],
    ["docs/agent/api.openapi.json", formatJson(openapi)],
    ["docs/agent/capabilities.json", formatJson(capabilities)],
    ["docs/agent/schema-index.json", formatJson(schemaIndex)]
  ]);
  const apiHash = sha256(rendered.get("docs/agent/api.openapi.json"));
''',
    '''  const rendered = new Map([
    ["docs/agent/SKILL.md", skill],
    ["docs/agent/api.openapi.json", formatJson(openapi)],
    ["docs/agent/capabilities.json", formatJson(capabilities)],
    ["docs/agent/schema-index.json", formatJson(schemaIndex)]
  ]);
  for (const recipe of AGENT_RECIPE_DEFINITIONS) {
    rendered.set(`docs/agent/recipes/${recipe.id}.md`, buildAgentRecipe(recipe));
  }
  const apiHash = sha256(rendered.get("docs/agent/api.openapi.json"));
''',
    "render recipes before docs hash"
)

replace_once(
    "scripts/generated-docs.mjs",
    '''    ["docs/agent/compatibility.json", formatJson(compatibility)],
    ["docs/agent/schema-index.json", rendered.get("docs/agent/schema-index.json")]
  ]);
}

export function computeGeneratedDocsHash(generated) {
''',
    '''    ["docs/agent/compatibility.json", formatJson(compatibility)],
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
      if (typeof path !== "string" || path.length < 1 || path.length > 240 || path.startsWith("/") || path.includes("\\\\") || path.split("/").includes("..")) {
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
  const paths = recipe.requiredPaths.map((path) => `- \`${path}\``).join("\\n");
  const commands = recipe.verificationScripts.map((script) => `- \`npm run ${script}\``).join("\\n");
  const invariants = recipe.invariants.map((item) => `- ${item}`).join("\\n");
  return `# ${recipe.title}\n\n${recipe.goal}\n\n> This recipe is generated documentation/task material only. It does not grant tools, permissions, shell access, repository mutation, deployment authority, secret access, or gameplay authority.\n\n## Required repository paths\n\n${paths}\n\n## Verification commands\n\nThese commands are evidence instructions for an authorized external workflow; this agent kit does not itself grant command execution.\n\n${commands}\n\n## Invariants\n\n${invariants}\n`;
}

export function computeGeneratedDocsHash(generated) {
''',
    "recipe validator and renderer"
)

# 2) Installed kit loader serves and hashes the same five recipes.
replace_once(
    "apps/server/src/agent-kit.ts",
    '''  "docs/agent/compatibility.json",
  "docs/agent/schema-index.json"
] as const);
const DOC_HASH_PATHS = Object.freeze([
  "docs/agent/SKILL.md",
  "docs/agent/api.openapi.json",
  "docs/agent/capabilities.json",
  "docs/agent/schema-index.json"
] as const);
''',
    '''  "docs/agent/compatibility.json",
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
''',
    "server kit recipe paths"
)

# 3) Contracts tests prove checked definitions and docsHash coverage.
replace_once(
    "packages/contracts/test/generated-docs.test.mjs",
    '''import {
  buildGeneratedDocs,
  computeGeneratedDocsHash,
  findStaleGeneratedPaths
} from "../../../scripts/generated-docs.mjs";
''',
    '''import {
  AGENT_RECIPE_DEFINITIONS,
  AGENT_RECIPE_PATHS,
  buildGeneratedDocs,
  computeGeneratedDocsHash,
  findStaleGeneratedPaths,
  validateAgentRecipeDefinitions
} from "../../../scripts/generated-docs.mjs";
''',
    "recipe test imports"
)
replace_once(
    "packages/contracts/test/generated-docs.test.mjs",
    '''  assert.equal(compatibility.docsHash, computeGeneratedDocsHash(generated));

  assert.equal(capabilities.contractsSchemaVersion, "1.0");
''',
    '''  assert.equal(compatibility.docsHash, computeGeneratedDocsHash(generated));
  assert.equal(AGENT_RECIPE_PATHS.length, 5);
  for (const path of AGENT_RECIPE_PATHS) {
    const recipe = generated.get(path);
    assert.equal(typeof recipe, "string");
    assert.match(recipe, /generated documentation\/task material only/);
    assert.match(recipe, /does not itself grant command execution/);
  }
  const changedRecipe = new Map(generated);
  changedRecipe.set(AGENT_RECIPE_PATHS[0], `${changedRecipe.get(AGENT_RECIPE_PATHS[0])}\\nchanged\\n`);
  assert.notEqual(computeGeneratedDocsHash(changedRecipe), compatibility.docsHash);

  assert.equal(capabilities.contractsSchemaVersion, "1.0");
''',
    "recipe files and hash coverage"
)

append = r'''

test("B10.b.10 checked agent recipes reject missing paths and unsafe verification scripts", async () => {
  const packageJson = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
  assert.equal(await validateAgentRecipeDefinitions(ROOT, packageJson), true);

  const missingPath = [{
    ...AGENT_RECIPE_DEFINITIONS[0],
    requiredPaths: ["packages/contracts/schemas/v1/definitely-missing.schema.json"]
  }];
  await assert.rejects(
    validateAgentRecipeDefinitions(ROOT, packageJson, missingPath),
    /Missing agent recipe path/
  );

  const existingButUnsafeScript = [{
    ...AGENT_RECIPE_DEFINITIONS[0],
    verificationScripts: ["build"]
  }];
  await assert.rejects(
    validateAgentRecipeDefinitions(ROOT, packageJson, existingButUnsafeScript),
    /Unsafe agent recipe verification script/
  );

  const commandLines = AGENT_RECIPE_DEFINITIONS.flatMap((recipe) =>
    recipe.verificationScripts.map((script) => `npm run ${script}`)
  );
  for (const command of commandLines) {
    assert.match(command, /^npm run [a-z0-9:-]+$/);
    assert.doesNotMatch(command, /(?:deploy|publish|curl|wget|git|shell|exec)/i);
  }
});
'''
path = Path("packages/contracts/test/generated-docs.test.mjs")
path.write_text(path.read_text() + append)

# 4) Server kit read proves all generated recipes are in the installed package.
replace_once(
    "apps/server/test/authoring-proposal-http.test.mjs",
    '''      "docs/agent/compatibility.json",
      "docs/agent/schema-index.json"
    ]);
''',
    '''      "docs/agent/compatibility.json",
      "docs/agent/schema-index.json",
      "docs/agent/recipes/quest-authoring.md",
      "docs/agent/recipes/scene-presentation.md",
      "docs/agent/recipes/plugin-extension.md",
      "docs/agent/recipes/ui-provider-extension.md",
      "docs/agent/recipes/migration-validation.md"
    ]);
    for (const file of kit.body.files.filter((item) => item.path.startsWith("docs/agent/recipes/"))) {
      assert.match(file.content, /generated documentation\/task material only/);
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
    }
''',
    "server kit recipe file list"
)

print("B10.b.10 checked agent recipes patch applied")
