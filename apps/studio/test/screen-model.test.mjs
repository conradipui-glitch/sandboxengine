import test from "node:test";
import assert from "node:assert/strict";
import {
  addScreenLayer,
  defaultScreen,
  removeScreenLayer,
  screenForNode,
  updateScreen
} from "../dist/src/screen-model.js";

function mission() {
  return {
    schemaVersion: "1.0", projectId: "p", questId: "q", contentRevision: 1, contentHash: "a".repeat(64),
    listing: { title: "М", slug: "mission-1", summary: "", coverAssetId: null, period: "", place: "", playerRole: "", estimatedMinutes: 10, supportedModes: ["choice"] },
    story: {
      entrySceneId: "s1",
      scenes: [{ id: "s1", title: "Сцена", text: "", dialogue: [], choices: [{ id: "c", label: "Финал", targetSceneId: null, endingId: "e1", conditions: [], effects: [] }] }],
      endings: [{ id: "e1", title: "Финал", text: "" }]
    },
    screens: { intros: [], scenes: {}, endings: {} },
    defaults: { background: null, theme: "", animationPreset: "" }
  };
}

const ref = { assetId: "asset-bg", hash: "b".repeat(64) };

test("M05 screens: missing scene/ending has a stable editable default", () => {
  assert.deepEqual(defaultScreen(), { background: null, inheritBackground: true, layers: [], music: null });
  assert.deepEqual(screenForNode(mission(), "s1"), defaultScreen());
  assert.deepEqual(screenForNode(mission(), "e1"), defaultScreen());
  assert.equal(screenForNode(mission(), "void"), null);
});

test("M05 screens: save background/inherit/music in the correct scene or ending slot", () => {
  const first = updateScreen(mission(), "s1", { background: ref, inheritBackground: false, music: null });
  assert.equal(first.ok, true);
  assert.deepEqual(first.mission.screens.scenes.s1.background, ref);
  assert.equal(first.mission.screens.scenes.s1.inheritBackground, false);
  const second = updateScreen(first.mission, "e1", { background: null, inheritBackground: true, music: ref });
  assert.equal(second.ok, true);
  assert.deepEqual(second.mission.screens.endings.e1.music, ref);
  assert.equal(second.mission.screens.scenes.s1.background.hash, "b".repeat(64));
});

test("M05 screens: layer transform is bounded and duplicate/missing layer operations fail closed", () => {
  const added = addScreenLayer(mission(), "s1", {
    id: "layer-1", kind: "actor", name: "Мастер", asset: ref,
    x: 0.4, y: 0.6, scale: 1.2, rotation: 15, flipH: false, flipV: false,
    opacity: 0.8, z: 3, visible: true, locked: false
  });
  assert.equal(added.ok, true);
  assert.equal(added.mission.screens.scenes.s1.layers.length, 1);
  assert.deepEqual([added.mission.screens.scenes.s1.layers[0].x, added.mission.screens.scenes.s1.layers[0].opacity], [0.4, 0.8]);
  const duplicate = addScreenLayer(added.mission, "s1", { ...added.mission.screens.scenes.s1.layers[0] });
  assert.deepEqual([duplicate.ok, duplicate.error], [false, "screen.layer_id_taken"]);
  const bad = addScreenLayer(mission(), "s1", { id: "bad", kind: "text", name: "x", asset: null, x: 2, y: 0, scale: 0, rotation: 0, flipH: false, flipV: false, opacity: 1, z: 0, visible: true, locked: false });
  assert.deepEqual([bad.ok, bad.error], [false, "screen.layer_transform_invalid"]);
  const removed = removeScreenLayer(added.mission, "s1", "layer-1");
  assert.equal(removed.ok, true);
  assert.equal(removed.mission.screens.scenes.s1.layers.length, 0);
  assert.deepEqual(removeScreenLayer(mission(), "s1", "void").error, "screen.layer_missing");
});
