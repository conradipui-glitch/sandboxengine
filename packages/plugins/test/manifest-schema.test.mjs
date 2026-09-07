import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import {
  ENGINE_PLUGIN_API_VERSION,
  PLUGIN_MANIFEST_SCHEMA_VERSION,
  validatePluginManifest
} from "../dist/index.js";
import { DICE_CHECK_MANIFEST } from "../dist/dice-check.js";

const schema = JSON.parse(await readFile(new URL("../schemas/v1/plugin-manifest.schema.json", import.meta.url), "utf8"));
const installed = JSON.parse(await readFile(new URL("../registry/installed.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);

function sample() {
  return {
    schemaVersion: "1.0",
    pluginId: "dice",
    version: "1.2.3",
    engineApiRange: { minInclusive: "1.0.0", maxExclusive: "2.0.0" },
    description: "Dice plugin",
    schemaVersions: [{ schemaId: "dice.schema.main", version: "1.0.0" }],
    dependencies: [],
    capabilityIds: ["dice.capability.roll"],
    recipeIds: ["dice.recipe.check"],
    backend: {
      blockTypeIds: ["dice.block.check"],
      actionTypeIds: ["dice.action.check"],
      scheduledEventTypeIds: [],
      effectTypeIds: []
    },
    ui: { components: [{ componentId: "dice.ui.indicator", propsSchemaId: "dice.schema.ui" }] }
  };
}

test("B08-01 canonical plugin manifest schema is Draft 2020-12 and matches runtime shape", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, "urn:living-history:plugin-manifest:1.0");
  assert.equal(schema.properties.schemaVersion.const, PLUGIN_MANIFEST_SCHEMA_VERSION);
  const value = sample();
  assert.equal(validateSchema(value), true, JSON.stringify(validateSchema.errors));
  assert.equal(validatePluginManifest(value).ok, true);
});

test("B08-01 schema rejects executable or raw UI widening", () => {
  const withImport = { ...sample(), importUrl: "https://example.test/plugin.js" };
  assert.equal(validateSchema(withImport), false);
  assert.equal(validatePluginManifest(withImport).ok, false);

  const withRawHtml = sample();
  withRawHtml.ui.components[0] = { ...withRawHtml.ui.components[0], html: "<button onclick='evil()'>x</button>" };
  assert.equal(validateSchema(withRawHtml), false);
  assert.equal(validatePluginManifest(withRawHtml).ok, false);
});

test("B08-03 build-installed registry metadata matches code versions and the actual dice-check manifest", () => {
  assert.deepEqual(Object.keys(installed).sort(), [
    "enginePluginApiVersion",
    "pluginManifestSchemaVersion",
    "plugins",
    "registryVersion"
  ]);
  assert.equal(installed.pluginManifestSchemaVersion, PLUGIN_MANIFEST_SCHEMA_VERSION);
  assert.equal(installed.enginePluginApiVersion, ENGINE_PLUGIN_API_VERSION);
  assert.equal(installed.registryVersion, "1.0");
  assert.equal(installed.plugins.length, 1);
  assert.equal(validateSchema(installed.plugins[0]), true, JSON.stringify(validateSchema.errors));
  assert.equal(validatePluginManifest(installed.plugins[0]).ok, true);
  assert.deepEqual(installed.plugins[0], JSON.parse(JSON.stringify(DICE_CHECK_MANIFEST)));
});
