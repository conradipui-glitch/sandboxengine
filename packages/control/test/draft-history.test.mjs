import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeDraftBlockReferences,
  compareDraftSnapshots,
  draftHistoryEntry
} from "../dist/index.js";

const location = (id, title = id) => Object.freeze({
  schemaVersion: "1.0", id, kind: "core.location", title, description: "", data: Object.freeze({})
});
const character = (id, locationId, status = "available") => Object.freeze({
  schemaVersion: "1.0", id, kind: "core.character", title: id, description: "", data: Object.freeze({ initialLocationId: locationId, initialStatus: status })
});
const resource = (id, initialValue = 2) => Object.freeze({
  schemaVersion: "1.0", id, kind: "core.resource", title: id, description: "", data: Object.freeze({ unit: "portion", initialValue, min: 0, max: 20 })
});
const action = (id, resourceId, cost = 1) => Object.freeze({
  schemaVersion: "1.0", id, kind: "core.action", title: id, description: "", data: Object.freeze({
    actionType: "core.paint", resourceId, resourceUnitsPerUnit: cost, durationSecondsPerUnit: 300, allowPartial: true
  })
});

function snapshot({ revision = 0, title = "Quest", entry = "workshop", blocks, questId = "quest", hash = "a".repeat(64) }) {
  return Object.freeze({
    projectId: "project", questId, draftRevision: revision, title, entryLocationId: entry,
    blocks: Object.freeze(blocks), contentHash: hash
  });
}

test("B09-03 history metadata is bounded deterministic author data and deeply immutable", () => {
  const source = snapshot({ blocks: [location("workshop"), resource("paint")] });
  const entry = draftHistoryEntry(source);
  assert.deepEqual(entry, {
    projectId: "project", questId: "quest", draftRevision: 0, contentHash: "a".repeat(64),
    title: "Quest", entryLocationId: "workshop", blockCount: 2
  });
  assert.equal(Object.isFrozen(entry), true);
  assert.equal("blocks" in entry, false);
});

test("B09-03 comparison reports title, entry, add/remove/replace without attempting an automatic merge", () => {
  const base = snapshot({
    revision: 2,
    blocks: [location("workshop"), location("yard"), resource("paint", 2), action("paint-wall", "paint", 1)]
  });
  const target = snapshot({
    revision: 5,
    title: "Quest v2",
    entry: "yard",
    hash: "b".repeat(64),
    blocks: [location("workshop"), location("yard"), resource("paint", 4), character("master", "workshop")]
  });
  assert.deepEqual(compareDraftSnapshots(base, target), {
    projectId: "project", questId: "quest", baseRevision: 2, targetRevision: 5,
    titleChanged: true, entryLocationChanged: true,
    addedBlockIds: ["master"], removedBlockIds: ["paint-wall"], replacedBlockIds: ["paint"]
  });
});

test("B09-03 comparison is semantic for canonical JSON key order and rejects cross-quest use", () => {
  const normal = resource("paint", 2);
  const reordered = Object.freeze({
    data: Object.freeze({ max: 20, min: 0, initialValue: 2, unit: "portion" }),
    description: "", title: "paint", kind: "core.resource", id: "paint", schemaVersion: "1.0"
  });
  const left = snapshot({ blocks: [location("workshop"), normal] });
  const right = snapshot({ revision: 1, hash: "b".repeat(64), blocks: [location("workshop"), reordered] });
  assert.deepEqual(compareDraftSnapshots(left, right).replacedBlockIds, []);
  assert.throws(() => compareDraftSnapshots(left, snapshot({ questId: "other", blocks: [location("workshop")] })), /same project and quest/);
});

test("B09-03 typed reference analysis explains quest, character and action dependencies", () => {
  const source = snapshot({
    revision: 3,
    blocks: [
      location("workshop"),
      location("yard"),
      character("master", "workshop"),
      resource("paint"),
      action("paint-wall", "paint")
    ]
  });

  const workshop = analyzeDraftBlockReferences(source, "workshop");
  assert.equal(workshop.targetExists, true);
  assert.equal(workshop.safeToDelete, false);
  assert.deepEqual(workshop.references, [
    { sourceKind: "block", sourceId: "master", path: "data.initialLocationId", targetBlockId: "workshop" },
    { sourceKind: "quest", sourceId: "quest", path: "entryLocationId", targetBlockId: "workshop" }
  ]);

  const paint = analyzeDraftBlockReferences(source, "paint");
  assert.deepEqual(paint.references, [
    { sourceKind: "block", sourceId: "paint-wall", path: "data.resourceId", targetBlockId: "paint" }
  ]);
  assert.equal(paint.safeToDelete, false);

  const yard = analyzeDraftBlockReferences(source, "yard");
  assert.equal(yard.safeToDelete, true);
  assert.deepEqual(yard.references, []);
});

test("B09-03 reference analysis does not treat descriptive strings as executable/reference authority", () => {
  const source = snapshot({
    blocks: [
      location("workshop"),
      Object.freeze({ ...location("yard"), description: "paint master workshop" }),
      character("master", "yard", "paint") ,
      resource("paint")
    ]
  });
  const paint = analyzeDraftBlockReferences(source, "paint");
  assert.equal(paint.safeToDelete, true);
  assert.deepEqual(paint.references, []);

  const missing = analyzeDraftBlockReferences(source, "missing");
  assert.equal(missing.targetExists, false);
  assert.equal(missing.safeToDelete, false);
  assert.deepEqual(missing.references, []);
});

test("B09-03 duplicate stored IDs fail closed instead of producing ambiguous comparison", () => {
  const corrupt = snapshot({ blocks: [location("workshop"), location("workshop")] });
  const other = snapshot({ revision: 1, blocks: [location("workshop")] });
  assert.throws(() => compareDraftSnapshots(corrupt, other), /duplicate block id/);
});
