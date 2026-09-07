import test from "node:test";
import assert from "node:assert/strict";
import {
  ENGINE_PLUGIN_API_VERSION,
  buildPluginRegistry,
  checkPluginRequirements,
  validatePluginManifest,
  versionInRange
} from "../dist/index.js";

const RANGE_1 = Object.freeze({ minInclusive: "1.0.0", maxExclusive: "2.0.0" });

function manifest(pluginId, overrides = {}) {
  return {
    schemaVersion: "1.0",
    pluginId,
    version: "1.0.0",
    engineApiRange: RANGE_1,
    description: `Plugin ${pluginId}`,
    schemaVersions: [{ schemaId: `${pluginId}.schema.main`, version: "1.0.0" }],
    dependencies: [],
    capabilityIds: [`${pluginId}.capability.main`],
    recipeIds: [`${pluginId}.recipe.main`],
    backend: {
      blockTypeIds: [`${pluginId}.block.main`],
      actionTypeIds: [`${pluginId}.action.main`],
      scheduledEventTypeIds: [`${pluginId}.event.main`],
      effectTypeIds: [`${pluginId}.effect.main`]
    },
    ui: {
      components: [{ componentId: `${pluginId}.ui.main`, propsSchemaId: `${pluginId}.schema.ui.main` }]
    },
    ...overrides
  };
}

function assertFailure(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
}

test("B08-01 zero-plugin registry is valid, deterministic and frozen", () => {
  const result = buildPluginRegistry([]);
  assert.equal(result.ok, true);
  assert.equal(result.registry.enginePluginApiVersion, ENGINE_PLUGIN_API_VERSION);
  assert.deepEqual(result.registry.pluginOrder, []);
  assert.deepEqual(result.registry.plugins, []);
  assert.equal(Object.isFrozen(result.registry), true);
  assert.equal(Object.isFrozen(result.registry.plugins), true);
});

test("B08-01 valid single plugin is normalized and deeply frozen", () => {
  const result = buildPluginRegistry([manifest("dice")]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.registry.pluginOrder, ["dice"]);
  assert.equal(result.registry.plugins[0].pluginId, "dice");
  assert.equal(Object.isFrozen(result.registry.plugins[0]), true);
  assert.equal(Object.isFrozen(result.registry.plugins[0].backend.actionTypeIds), true);
  assert.equal(result.registry.ownedIds.some((entry) => entry.id === "dice.action.main"), true);
});

test("B08-01 dependency graph sorts dependencies first and insertion order is irrelevant", () => {
  const base = manifest("base");
  const dice = manifest("dice", {
    dependencies: [{ pluginId: "base", versionRange: RANGE_1 }]
  });
  const ui = manifest("ui", {
    dependencies: [{ pluginId: "base", versionRange: RANGE_1 }]
  });
  const left = buildPluginRegistry([ui, dice, base]);
  const right = buildPluginRegistry([base, dice, ui]);
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  assert.deepEqual(left.registry, right.registry);
  assert.deepEqual(left.registry.pluginOrder, ["base", "dice", "ui"]);
});

test("B08-01 missing dependency fails closed", () => {
  const result = buildPluginRegistry([manifest("dice", {
    dependencies: [{ pluginId: "base", versionRange: RANGE_1 }]
  })]);
  assertFailure(result, "MISSING_DEPENDENCY");
  assert.equal(result.dependencyId, "base");
});

test("B08-01 dependency version mismatch fails closed", () => {
  const base = manifest("base", { version: "2.0.0", engineApiRange: RANGE_1 });
  const dice = manifest("dice", {
    dependencies: [{ pluginId: "base", versionRange: RANGE_1 }]
  });
  assertFailure(buildPluginRegistry([base, dice]), "DEPENDENCY_VERSION_MISMATCH");
});

test("B08-01 dependency cycles are rejected", () => {
  const a = manifest("alpha", { dependencies: [{ pluginId: "beta", versionRange: RANGE_1 }] });
  const b = manifest("beta", { dependencies: [{ pluginId: "alpha", versionRange: RANGE_1 }] });
  assertFailure(buildPluginRegistry([a, b]), "DEPENDENCY_CYCLE");
});

test("B08-01 duplicate plugin IDs are rejected", () => {
  assertFailure(buildPluginRegistry([manifest("dice"), manifest("dice")]), "DUPLICATE_PLUGIN_ID");
});

test("B08-01 cross-plugin ownership collisions are rejected even with valid namespaces", () => {
  const parent = manifest("alpha", {
    capabilityIds: ["alpha.sub.capability.main"],
    schemaVersions: [],
    recipeIds: [],
    backend: { blockTypeIds: [], actionTypeIds: [], scheduledEventTypeIds: [], effectTypeIds: [] },
    ui: null
  });
  const child = manifest("alpha.sub", {
    capabilityIds: ["alpha.sub.capability.main"],
    schemaVersions: [],
    recipeIds: [],
    backend: { blockTypeIds: [], actionTypeIds: [], scheduledEventTypeIds: [], effectTypeIds: [] },
    ui: null
  });
  assertFailure(buildPluginRegistry([parent, child]), "GLOBAL_ID_COLLISION");
});

test("B08-01 non-namespaced plugin-owned IDs are rejected", () => {
  const invalid = manifest("dice", { capabilityIds: ["other.capability.roll"] });
  const validated = validatePluginManifest(invalid);
  assert.equal(validated.ok, false);
  assert.match(validated.reason, /not namespaced/);
});

test("B08-01 duplicate IDs inside one manifest are rejected across categories", () => {
  const invalid = manifest("dice", {
    capabilityIds: ["dice.shared"],
    recipeIds: ["dice.shared"]
  });
  const validated = validatePluginManifest(invalid);
  assert.equal(validated.ok, false);
  assert.match(validated.reason, /duplicate plugin-owned id/);
});

test("B08-01 manifest exact shape rejects executable/import URL/raw HTML/source widening", () => {
  const withUrl = { ...manifest("dice"), importUrl: "https://example.test/plugin.js" };
  assert.equal(validatePluginManifest(withUrl).ok, false);

  const withSource = { ...manifest("dice"), source: "export default 1" };
  assert.equal(validatePluginManifest(withSource).ok, false);

  const withHtml = manifest("dice", {
    ui: { components: [{ componentId: "dice.ui.main", propsSchemaId: "dice.schema.ui.main", html: "<button onclick='x()'>" }] }
  });
  assert.equal(validatePluginManifest(withHtml).ok, false);
});

test("B08-01 incompatible engine plugin API range is rejected", () => {
  const result = buildPluginRegistry([manifest("dice", {
    engineApiRange: { minInclusive: "2.0.0", maxExclusive: "3.0.0" }
  })]);
  assertFailure(result, "ENGINE_API_INCOMPATIBLE");
});

test("B08-01 strict version ranges are deterministic", () => {
  assert.equal(versionInRange("1.0.0", RANGE_1), true);
  assert.equal(versionInRange("1.9.9", RANGE_1), true);
  assert.equal(versionInRange("2.0.0", RANGE_1), false);
  assert.equal(versionInRange("1.0", RANGE_1), false);
});

test("B08-01 release compatibility fails explicitly for missing/incompatible plugin capability and schema", () => {
  const built = buildPluginRegistry([manifest("dice")]);
  assert.equal(built.ok, true);

  const compatible = checkPluginRequirements(built.registry, {
    plugins: [{
      pluginId: "dice",
      versionRange: RANGE_1,
      capabilityIds: ["dice.capability.main"],
      schemaVersions: [{ schemaId: "dice.schema.main", version: "1.0.0" }]
    }]
  });
  assert.equal(compatible.compatible, true);

  const incompatible = checkPluginRequirements(built.registry, {
    plugins: [
      {
        pluginId: "dice",
        versionRange: { minInclusive: "1.1.0", maxExclusive: "2.0.0" },
        capabilityIds: ["dice.capability.missing"],
        schemaVersions: [
          { schemaId: "dice.schema.main", version: "2.0.0" },
          { schemaId: "dice.schema.missing", version: "1.0.0" }
        ]
      },
      {
        pluginId: "absent",
        versionRange: RANGE_1,
        capabilityIds: [],
        schemaVersions: []
      }
    ]
  });
  assert.equal(incompatible.compatible, false);
  assert.deepEqual(incompatible.issues.map((issue) => issue.code), [
    "MISSING_PLUGIN",
    "PLUGIN_VERSION_INCOMPATIBLE",
    "MISSING_CAPABILITY",
    "SCHEMA_VERSION_INCOMPATIBLE",
    "MISSING_SCHEMA"
  ].sort((a, b) => {
    const order = ["MISSING_PLUGIN", "PLUGIN_VERSION_INCOMPATIBLE", "MISSING_CAPABILITY", "SCHEMA_VERSION_INCOMPATIBLE", "MISSING_SCHEMA"];
    return order.indexOf(a) - order.indexOf(b);
  }));
});

test("B08-01 invalid requirement shape fails closed", () => {
  const built = buildPluginRegistry([manifest("dice")]);
  assert.equal(built.ok, true);
  const result = checkPluginRequirements(built.registry, {
    plugins: [{
      pluginId: "dice",
      versionRange: RANGE_1,
      capabilityIds: ["dice.capability.main", "dice.capability.main"],
      schemaVersions: []
    }]
  });
  assert.equal(result.compatible, false);
  assert.equal(result.issues[0].code, "INVALID_REQUIREMENTS");
});
