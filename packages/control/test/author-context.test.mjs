import test from "node:test";
import assert from "node:assert/strict";
import {
  CORE_ONLY_AUTHOR_CONTEXT_CAPABILITY_CATALOG,
  buildAuthorContextBundle
} from "../dist/author-context.js";

const HASH = "a".repeat(64);
const location = (id) => ({ schemaVersion: "1.0", id, kind: "core.location", title: id, description: "", data: {} });
const resource = (id) => ({ schemaVersion: "1.0", id, kind: "core.resource", title: id, description: "", data: { unit: "u", initialValue: 2, min: 0, max: 10 } });
const character = (id, initialLocationId) => ({ schemaVersion: "1.0", id, kind: "core.character", title: id, description: "", data: { initialLocationId } });
const action = (id, resourceId) => ({ schemaVersion: "1.0", id, kind: "core.action", title: id, description: "", data: { actionType: "core.paint", resourceId, resourceUnitsPerUnit: 1, durationSecondsPerUnit: 1, allowPartial: true } });

function snapshot(blocks) {
  return { projectId: "p1", questId: "q1", draftRevision: 4, title: "Quest", entryLocationId: "workshop", contentHash: HASH, blocks };
}

test("B10.b.9 selected action expands one outgoing resource dependency and omits unrelated/inbound blocks", () => {
  const value = snapshot([
    location("workshop"), location("backstage"), resource("paint"), resource("unused"),
    action("paint-wall", "paint"), action("other-action", "paint"), character("artist", "backstage")
  ]);
  const result = buildAuthorContextBundle(value, ["paint-wall"]);
  assert.equal(result.kind, "built");
  assert.deepEqual(result.bundle.selectedBlockIds, ["paint-wall"]);
  assert.deepEqual(result.bundle.dependencyBlockIds, ["paint"]);
  assert.deepEqual(result.bundle.includedBlockIds, ["paint", "paint-wall"]);
  assert.deepEqual(result.bundle.blocks.map((block) => block.id), ["paint", "paint-wall"]);
  assert.equal(result.bundle.blocks.some((block) => block.id === "other-action"), false);
  assert.equal(result.bundle.blocks.some((block) => block.id === "workshop"), false);
});

test("B10.b.9 selected character includes its initial location only", () => {
  const result = buildAuthorContextBundle(snapshot([
    location("workshop"), location("backstage"), resource("paint"), character("artist", "backstage")
  ]), ["artist"]);
  assert.equal(result.kind, "built");
  assert.deepEqual(result.bundle.includedBlockIds, ["artist", "backstage"]);
});

test("B10.b.9 selector fails closed for bad selection, duplicate stored ids and missing typed targets", () => {
  const valid = snapshot([location("workshop"), resource("paint"), action("paint-wall", "paint")]);
  assert.equal(buildAuthorContextBundle(valid, []).code, "invalid_selection");
  assert.equal(buildAuthorContextBundle(valid, ["paint", "paint"]).code, "invalid_selection");
  assert.equal(buildAuthorContextBundle(valid, ["missing"]).code, "selected_block_not_found");

  const duplicate = snapshot([location("workshop"), location("workshop")]);
  assert.equal(buildAuthorContextBundle(duplicate, ["workshop"]).code, "duplicate_stored_block_id");

  const broken = snapshot([location("workshop"), action("paint-wall", "missing-resource")]);
  assert.equal(buildAuthorContextBundle(broken, ["paint-wall"]).code, "missing_typed_dependency");
});

test("B10.b.9 capability catalog is deterministic, bounded and deeply immutable", () => {
  const catalog = {
    coreBlockKinds: ["core.resource", "core.location", "core.action", "core.character"],
    pluginCapabilityIds: ["dice.roll", "dice.roll", "dice.check"],
    pluginBlockTypeIds: ["dice.block"],
    pluginActionTypeIds: ["dice.action"]
  };
  const result = buildAuthorContextBundle(snapshot([location("workshop")]), ["workshop"], catalog);
  assert.equal(result.kind, "built");
  assert.deepEqual(result.bundle.capabilities.pluginCapabilityIds, ["dice.check", "dice.roll"]);
  assert.equal(Object.isFrozen(result.bundle), true);
  assert.equal(Object.isFrozen(result.bundle.blocks), true);
  assert.equal(Object.isFrozen(result.bundle.capabilities), true);

  const core = buildAuthorContextBundle(snapshot([location("workshop")]), ["workshop"], CORE_ONLY_AUTHOR_CONTEXT_CAPABILITY_CATALOG);
  assert.equal(core.kind, "built");
  assert.deepEqual(core.bundle.capabilities.pluginCapabilityIds, []);
});
