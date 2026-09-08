import test from "node:test";
import assert from "node:assert/strict";
import { buildInstalledAuthorContextCapabilityCatalog } from "../dist/author-context-catalog.js";

test("B10.b.9 installed plugin registry becomes a sorted safe author capability catalog", () => {
  const registry = {
    plugins: [
      { capabilityIds: ["dice.roll", "dice.check"], backend: { blockTypeIds: ["dice.block"], actionTypeIds: ["dice.action"] } },
      { capabilityIds: ["dice.check", "weather.read"], backend: { blockTypeIds: [], actionTypeIds: ["weather.action"] } }
    ]
  };
  const catalog = buildInstalledAuthorContextCapabilityCatalog(registry);
  assert.deepEqual(catalog.coreBlockKinds, ["core.action", "core.character", "core.location", "core.resource"]);
  assert.deepEqual(catalog.pluginCapabilityIds, ["dice.check", "dice.roll", "weather.read"]);
  assert.deepEqual(catalog.pluginBlockTypeIds, ["dice.block"]);
  assert.deepEqual(catalog.pluginActionTypeIds, ["dice.action", "weather.action"]);
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(Object.isFrozen(catalog.pluginCapabilityIds), true);
});
