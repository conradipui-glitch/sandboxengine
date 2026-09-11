import test from "node:test";
import assert from "node:assert/strict";

import {
  SCREEN_MAX_SCALE,
  SCREEN_MIN_SCALE,
  SCREEN_NUDGE_STEP,
  SCREEN_NUDGE_STEP_LARGE,
  applyScreenDrag,
  applyScreenLayerAction,
  applyScreenResize,
  clampScreenCoordinate,
  duplicateScreenLayer,
  fitScreenAsset,
  flipScreenLayer,
  moveScreenLayer,
  nextScreenLayerId,
  normalizeAnimationPreset,
  normalizeRotation,
  orderedScreenLayers,
  reorderScreenLayer,
  resizeScreenLayer,
  resolveScreenAnimation,
  resolveScreenBackground,
  resolveScreenMusic,
  rotateScreenLayer,
  screenKeyAction,
  screenLayerHitTest,
  setScreenLayerOpacity,
  toggleScreenLayerLocked,
  toggleScreenLayerVisible,
  translateScreenLayer,
  updateScreenLayer
} from "../dist/src/screen-composition.js";
import { addScreenLayer, screenForNode } from "../dist/src/screen-model.js";
import { missionContentHash, validateMissionDraft } from "../../../packages/contracts/dist/index.js";
import { StudioApp } from "../dist/src/app.js";

// StudioApp.render() читает document.activeElement; браузера в тестах нет.
globalThis.document ??= { activeElement: null };
globalThis.HTMLElement ??= class {};

const ref = { assetId: "asset-bg", hash: "b".repeat(64) };

function layer(id, over = {}) {
  return {
    id, kind: "actor", name: `Слой ${id}`, asset: ref,
    x: 0.5, y: 0.5, scale: 1, rotation: 0, flipH: false, flipV: false,
    opacity: 1, z: 1, visible: true, locked: false, ...over
  };
}

function mission() {
  return {
    schemaVersion: "1.0", projectId: "p", questId: "q", contentRevision: 1, contentHash: "c".repeat(64),
    listing: {
      title: "М", slug: "mission-1", summary: "", coverAssetId: null, period: "", place: "",
      playerRole: "", estimatedMinutes: 10, supportedModes: ["choice"]
    },
    story: {
      entrySceneId: "s1",
      scenes: [{ id: "s1", title: "Сцена", text: "", dialogue: [], choices: [{ id: "c", label: "Финал", targetSceneId: null, endingId: "e1", conditions: [], effects: [] }] }],
      endings: [{ id: "e1", title: "Финал", text: "" }]
    },
    screens: {
      intros: [],
      scenes: { s1: { background: null, inheritBackground: true, layers: [layer("l1", { z: 1 }), layer("l2", { z: 2 })], music: null } },
      endings: {}
    },
    defaults: { background: null, theme: "", animationPreset: "fade" }
  };
}

function layerOf(doc, nodeId, layerId) {
  const screen = screenForNode(doc, nodeId);
  return screen.layers.find((entry) => entry.id === layerId);
}

test("FIN-05B update layer writes the full transform and fails closed on bad input", () => {
  const doc = mission();
  const moved = updateScreenLayer(doc, "s1", "l1", { x: 0.2, y: 0.8, scale: 1.5, rotation: 45, opacity: 0.4, flipH: true });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  const l1 = layerOf(moved.mission, "s1", "l1");
  assert.deepEqual([l1.x, l1.y, l1.scale, l1.rotation, l1.opacity, l1.flipH], [0.2, 0.8, 1.5, 45, 0.4, true]);
  assert.equal(l1.id, "l1", "id is preserved");
  // original untouched
  assert.deepEqual([layerOf(doc, "s1", "l1").x, layerOf(doc, "s1", "l1").scale], [0.5, 1]);
  // fail closed
  assert.deepEqual([updateScreenLayer(doc, "s1", "l1", { x: 2 }).ok, updateScreenLayer(doc, "s1", "l1", { x: 2 }).error], [false, "screen.layer_transform_invalid"]);
  assert.equal(updateScreenLayer(doc, "s1", "l1", { opacity: -1 }).error, "screen.layer_transform_invalid");
  assert.equal(updateScreenLayer(doc, "s1", "l1", { scale: 0 }).error, "screen.layer_transform_invalid");
  assert.equal(updateScreenLayer(doc, "s1", "l1", { z: 1.5 }).error, "screen.layer_transform_invalid");
  assert.equal(updateScreenLayer(doc, "s1", "void", { x: 0.1 }).error, "screen.layer_missing");
  assert.equal(updateScreenLayer(doc, "void", "l1", { x: 0.1 }).error, "screen.node_missing");
});

test("FIN-05B duplicate layer gets a fresh id above the top and rejects collisions", () => {
  const doc = mission();
  const dup = duplicateScreenLayer(doc, "s1", "l1", "l1-copy");
  assert.equal(dup.ok, true);
  const copy = layerOf(dup.mission, "s1", "l1-copy");
  assert.equal(copy.name, "Слой l1 (копия)");
  assert.equal(copy.z, 3, "copy lands above the current top");
  assert.deepEqual([copy.x, copy.scale], [0.5, 1]);
  const screen = screenForNode(dup.mission, "s1");
  assert.equal(screen.layers.length, 3);
  assert.equal(screen.layers.filter((entry) => entry.id === "l1").length, 1, "source still unique");
  assert.equal(duplicateScreenLayer(doc, "s1", "l1", "l2").error, "screen.layer_id_taken");
  assert.equal(duplicateScreenLayer(doc, "s1", "void").error, "screen.layer_missing");
  assert.equal(nextScreenLayerId(screen.layers, "l1-copy"), "l1-copy-2");
});

test("FIN-05B move/resize/rotate/flip/opacity clamp deterministically", () => {
  const doc = mission();
  assert.equal(moveScreenLayer(doc, "s1", "l1", 2, -3).ok, true);
  const clamped = layerOf(moveScreenLayer(doc, "s1", "l1", 2, -3).mission, "s1", "l1");
  assert.deepEqual([clamped.x, clamped.y], [1, 0]);
  assert.equal(clampScreenCoordinate(Number.NaN), 0);

  const nudged = layerOf(translateScreenLayer(doc, "s1", "l1", 0.1, -0.2).mission, "s1", "l1");
  assert.ok(Math.abs(nudged.x - 0.6) < 1e-9 && Math.abs(nudged.y - 0.3) < 1e-9);

  const big = layerOf(resizeScreenLayer(doc, "s1", "l1", 99).mission, "s1", "l1");
  assert.equal(big.scale, SCREEN_MAX_SCALE);
  assert.equal(layerOf(resizeScreenLayer(doc, "s1", "l1", 0).mission, "s1", "l1").scale, SCREEN_MIN_SCALE);

  assert.equal(normalizeRotation(370), 10);
  assert.equal(normalizeRotation(-190), 170);
  assert.equal(normalizeRotation(180), 180);
  assert.equal(layerOf(rotateScreenLayer(doc, "s1", "l1", 370).mission, "s1", "l1").rotation, 10);

  assert.equal(layerOf(flipScreenLayer(doc, "s1", "l1", "h").mission, "s1", "l1").flipH, true);
  assert.equal(layerOf(flipScreenLayer(doc, "s1", "l1", "v").mission, "s1", "l1").flipV, true);
  assert.equal(layerOf(setScreenLayerOpacity(doc, "s1", "l1", 5).mission, "s1", "l1").opacity, 1);
  assert.equal(layerOf(setScreenLayerOpacity(doc, "s1", "l1", -5).mission, "s1", "l1").opacity, 0);
  assert.equal(layerOf(toggleScreenLayerVisible(doc, "s1", "l1").mission, "s1", "l1").visible, false);
  assert.equal(layerOf(toggleScreenLayerLocked(doc, "s1", "l1").mission, "s1", "l1").locked, true);
});

test("FIN-05B z-order reorders by one step and renumbers z uniquely", () => {
  const doc = mission();
  const forward = reorderScreenLayer(doc, "s1", "l1", "forward");
  assert.equal(forward.ok, true);
  const afterForward = orderedScreenLayers(screenForNode(forward.mission, "s1")).map((entry) => entry.id);
  assert.deepEqual(afterForward, ["l2", "l1"]);
  assert.deepEqual(screenForNode(forward.mission, "s1").layers.map((entry) => entry.z).sort(), [1, 2]);

  const front = reorderScreenLayer(doc, "s1", "l1", "front");
  assert.deepEqual(orderedScreenLayers(screenForNode(front.mission, "s1")).map((entry) => entry.id), ["l2", "l1"]);
  const back = reorderScreenLayer(doc, "s1", "l2", "back");
  assert.deepEqual(orderedScreenLayers(screenForNode(back.mission, "s1")).map((entry) => entry.id), ["l2", "l1"]);
  const backwardTop = reorderScreenLayer(doc, "s1", "l2", "backward");
  assert.deepEqual(orderedScreenLayers(screenForNode(backwardTop.mission, "s1")).map((entry) => entry.id), ["l2", "l1"]);

  // no-op for the already-top layer keeps a valid document
  const noop = reorderScreenLayer(doc, "s1", "l2", "forward");
  assert.equal(noop.ok, true);
  assert.deepEqual(orderedScreenLayers(screenForNode(noop.mission, "s1")).map((entry) => entry.id), ["l1", "l2"]);
  assert.equal(reorderScreenLayer(doc, "s1", "void", "front").error, "screen.layer_missing");
});

test("FIN-05B layer action dispatcher routes every action", () => {
  const doc = mission();
  assert.equal(layerOf(applyScreenLayerAction(doc, "s1", "l1", "flip-h").mission, "s1", "l1").flipH, true);
  assert.equal(layerOf(applyScreenLayerAction(doc, "s1", "l1", "toggle-visible").mission, "s1", "l1").visible, false);
  assert.equal(layerOf(applyScreenLayerAction(doc, "s1", "l1", "toggle-lock").mission, "s1", "l1").locked, true);
  const dup = applyScreenLayerAction(doc, "s1", "l1", "duplicate");
  assert.equal(dup.mission.screens.scenes.s1.layers.length, 3);
  const removed = applyScreenLayerAction(dup.mission, "s1", "l1-copy", "delete");
  assert.equal(removed.mission.screens.scenes.s1.layers.some((entry) => entry.id === "l1-copy"), false);
  assert.equal(applyScreenLayerAction(doc, "s1", "void", "delete").error, "screen.layer_missing");
});

test("FIN-05B hit test picks the topmost visible layer", () => {
  const layers = [layer("l1", { x: 0.5, y: 0.5, z: 1 }), layer("l2", { x: 0.5, y: 0.5, z: 5 })];
  assert.equal(screenLayerHitTest(layers, 0.5, 0.5).id, "l2");
  assert.equal(screenLayerHitTest(layers, 0.05, 0.05), null, "empty frame area hits nothing");
  const hidden = [layer("l1", { x: 0.5, y: 0.5, z: 9, visible: false }), layer("l2", { x: 0.5, y: 0.5, z: 1 })];
  assert.equal(screenLayerHitTest(hidden, 0.5, 0.5).id, "l2", "hidden layer is not hittable");
});

test("FIN-05B drag keeps the pointer under the layer and resize is proportional", () => {
  const base = layer("l1", { x: 0.5, y: 0.5, scale: 1 });
  assert.deepEqual(applyScreenDrag(base, { x: 0.25, y: 0.75 }), { x: 0.25, y: 0.75, scale: 1, rotation: 0 });
  assert.deepEqual(applyScreenDrag(base, { x: 5, y: -5 }), { x: 1, y: 0, scale: 1, rotation: 0 });

  const doubled = applyScreenResize(base, { x: 0.75, y: 0.5 }, { x: 1, y: 0.5 });
  assert.equal(doubled.scale, 2, "distance from center doubled -> scale doubled");
  assert.equal(doubled.x, 0.5);
  const clamped = applyScreenResize(base, { x: 0.75, y: 0.5 }, { x: 50, y: 0.5 });
  assert.equal(clamped.scale, SCREEN_MAX_SCALE);
  const degenerate = applyScreenResize(base, { x: 0.5, y: 0.5 }, { x: 1, y: 1 });
  assert.equal(degenerate.scale, 1, "zero start distance is ignored, not NaN");
  const off = applyScreenResize(base, { x: 0.75, y: 0.5 }, { x: 1, y: 0.5 }, { keepAspect: false });
  assert.equal(off.scale, 1);
});

test("FIN-05B background fit handles contain/cover, focal point and crop", () => {
  const wide = fitScreenAsset(16 / 9, 4 / 3, "contain");
  assert.equal(wide.mode, "contain");
  assert.ok(wide.width <= 4 / 3 + 1e-9, "contain never overflows horizontally");
  assert.equal(wide.crop, false);
  assert.ok(Math.abs(wide.offsetX - (4 / 3 - wide.width) / 2) < 1e-9, "centered when focal is 0.5");

  const cover = fitScreenAsset(1, 2, "cover");
  assert.equal(cover.crop, true);
  assert.ok(cover.width >= 2 - 1e-9);

  const focused = fitScreenAsset(2, 1, "cover", { x: 0, y: 0.5 });
  assert.ok(focused.sourceX >= 0 && focused.sourceX + focused.sourceW <= 1 + 1e-9);
  assert.ok(focused.sourceW <= 1 && focused.sourceH <= 1);
  // the focal point of the asset lands in the center of the frame
  assert.ok(Math.abs(focused.offsetX + 0 * focused.width - 1 / 2) < 1e-9, "focal x maps to frame center");
  assert.equal(fitScreenAsset(Number.NaN, 1, "cover").width > 0, true);
});

test("FIN-05B background inheritance resolves own, inherited and none", () => {
  const screen = { background: null, inheritBackground: true, layers: [], music: null };
  const defaults = { background: ref, theme: "", animationPreset: "" };
  assert.deepEqual(resolveScreenBackground(screen, defaults), { ref, source: "inherited" });
  assert.deepEqual(resolveScreenBackground({ ...screen, background: ref }, defaults).source, "own");
  assert.deepEqual(resolveScreenBackground({ ...screen, inheritBackground: false }, defaults).source, "none");
  assert.deepEqual(resolveScreenBackground({ ...screen, inheritBackground: false }, { ...defaults, background: null }).ref, null);
});

test("FIN-05B animation preset respects reduced-motion and pause", () => {
  assert.equal(normalizeAnimationPreset(" FADE "), "fade");
  assert.equal(normalizeAnimationPreset("unknown"), "none");
  assert.deepEqual(resolveScreenAnimation("rise", { reducedMotion: false, paused: false }), { preset: "rise", animate: true, reason: "ok" });
  assert.deepEqual(resolveScreenAnimation("rise", { reducedMotion: true, paused: false }), { preset: "rise", animate: false, reason: "reduced-motion" });
  assert.deepEqual(resolveScreenAnimation("rise", { reducedMotion: false, paused: true }), { preset: "rise", animate: false, reason: "paused" });
  assert.equal(resolveScreenAnimation("none", { reducedMotion: false, paused: false }).animate, false);
});

test("FIN-05B music exposes real mute/play/blocked states", () => {
  assert.equal(resolveScreenMusic({ hasTrack: false, muted: false, autoplayAllowed: true }).state, "none");
  assert.equal(resolveScreenMusic({ hasTrack: true, muted: true, autoplayAllowed: true }).state, "muted");
  assert.equal(resolveScreenMusic({ hasTrack: true, muted: false, autoplayAllowed: false }).state, "blocked");
  const playing = resolveScreenMusic({ hasTrack: true, muted: false, autoplayAllowed: true });
  assert.deepEqual([playing.state, playing.shouldPlay], ["playing", true]);
  assert.match(resolveScreenMusic({ hasTrack: true, muted: false, autoplayAllowed: false }).label, /автозапуск/);
});

test("FIN-05B keyboard map covers nudge, z-order, visible/lock, delete and deselect", () => {
  assert.equal(screenKeyAction({ key: "Delete" }), "delete");
  assert.equal(screenKeyAction({ key: "Backspace" }), "delete");
  assert.equal(screenKeyAction({ key: "Escape" }), "deselect");
  assert.equal(screenKeyAction({ key: "ArrowLeft" }), "nudge-left");
  assert.equal(screenKeyAction({ key: "ArrowRight", shiftKey: true }), "nudge-right-large");
  assert.equal(screenKeyAction({ key: "[" }), "backward");
  assert.equal(screenKeyAction({ key: "]" }), "forward");
  assert.equal(screenKeyAction({ key: "{" }), "back");
  assert.equal(screenKeyAction({ key: "}" }), "front");
  assert.equal(screenKeyAction({ key: "v" }), "toggle-visible");
  assert.equal(screenKeyAction({ key: "l" }), "toggle-lock");
  assert.equal(screenKeyAction({ key: "d" }), "duplicate");
  assert.equal(screenKeyAction({ key: "a" }), null);
  assert.equal(screenKeyAction({ key: "Delete", ctrlKey: true }), null, "strict modifiers");
  assert.equal(screenKeyAction({ key: "z", metaKey: true }), null);
  assert.equal(SCREEN_NUDGE_STEP, 0.01);
  assert.equal(SCREEN_NUDGE_STEP_LARGE, 0.05);
});

test("FIN-05B composition is part of the content hash; it stays a valid mission", async () => {
  const doc = mission();
  assert.deepEqual(validateMissionDraft(doc), []);
  const before = await missionContentHash(doc);
  const moved = updateScreenLayer(doc, "s1", "l1", { x: 0.9, y: 0.1, scale: 2 });
  const after = await missionContentHash(moved.mission);
  assert.notEqual(after, before, "screen composition is authored content and must move the hash");
  assert.deepEqual(validateMissionDraft(moved.mission), []);
});

function fakeRoot() {
  const listeners = {};
  return {
    innerHTML: "",
    listeners,
    addEventListener(type, handler) { (listeners[type] ??= []).push(handler); },
    querySelector() { return null; }
  };
}

function bootScreenApp(layerId) {
  const root = fakeRoot();
  const app = new StudioApp(root, { async listProjects() { return []; } });
  app.state.access = Object.freeze({ mode: "local-owner", auth: null, mutationProof: true, members: null, membersError: null });
  app.state.view = "editor";
  app.state.projects = Object.freeze([{ projectId: "p", title: "Проект", role: "owner" }]);
  app.state.selectedProjectId = "p";
  app.state.selectedQuestId = "q";
  app.state.quests = Object.freeze([{ projectId: "p", questId: "q", draftRevision: 1, title: "Квест", entryLocationId: "s1", contentHash: "x".repeat(64) }]);
  app.state.draft = Object.freeze({ projectId: "p", questId: "q", draftRevision: 1, title: "Квест", entryLocationId: "s1", contentHash: "x".repeat(64), blocks: Object.freeze([]) });
  app.state.mission = mission();
  app.state.missionRevision = 1;
  app.state.boardView = "story";
  app.state.selectedStoryNodeId = "s1";
  app.state.selectedScreenLayerId = layerId;
  app.render();
  return { app, root };
}

test("FIN-05B Studio screen editor exposes layer transform actions and the targeted edit form", () => {
  const { root } = bootScreenApp("l1");
  assert.match(root.innerHTML, /data-action="screen-layer-action"/);
  assert.match(root.innerHTML, /data-layer-action="front"/);
  assert.match(root.innerHTML, /data-layer-action="flip-h"/);
  assert.match(root.innerHTML, /data-layer-action="toggle-visible"/);
  assert.match(root.innerHTML, /data-layer-action="duplicate"/);
  assert.match(root.innerHTML, /data-action="screen-select-layer"/);
  assert.match(root.innerHTML, /data-form="screen-layer-edit"/);
  assert.match(root.innerHTML, /data-form="screen-layer-add"/);
  assert.match(root.innerHTML, /data-screen-host/);
  // only the selected layer shows the inline edit form
  assert.equal((root.innerHTML.match(/data-form="screen-layer-edit"/g) ?? []).length, 1);
  // an unselected layer does not
  const other = bootScreenApp(null);
  assert.equal((other.root.innerHTML.match(/data-form="screen-layer-edit"/g) ?? []).length, 0);
});

// --- Минимальный DOM-шим: проверяем реальный screen-dom.ts без браузера ---

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.className = "";
    this.textContent = "";
    this.handlers = {};
    this.disabled = false;
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) { this.children.splice(i, 1); child.parentNode = null; } return child; }
  get firstChild() { return this.children[0] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === "class") this.className = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, handler) { (this.handlers[type] ??= []).push(handler); }
  removeEventListener(type, handler) { const list = this.handlers[type]; if (list) { const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1); } }
  dispatch(type, event) { for (const handler of this.handlers[type] ?? []) handler(event); }
  remove() { this.parentNode?.removeChild(this); }
  closest(selector) { const cls = selector.replace(/^\./, ""); let node = this; while (node) { if ((node.className || "").split(/\s+/).includes(cls)) return node; node = node.parentNode; } return null; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const results = [];
    const attrMatch = selector.match(/^\[([^=\]]+)="(.*)"\]$/);
    const bareAttr = !attrMatch && /^\[[^\]]+\]$/.test(selector) ? selector.slice(1, -1) : null;
    const walk = (node) => {
      for (const child of node.children) {
        const cls = (child.className || "").split(/\s+/);
        let ok = false;
        if (attrMatch) ok = child.attributes[attrMatch[1]] === attrMatch[2] || child.dataset[attrMatch[1].replace(/^data-/, "").replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] === attrMatch[2];
        else if (bareAttr) ok = bareAttr in child.attributes;
        else if (selector.startsWith(".")) ok = cls.includes(selector.slice(1));
        else ok = child.tagName.toLowerCase() === selector.toLowerCase();
        if (ok) results.push(child);
        walk(child);
      }
    };
    walk(this);
    return results;
  }
  getBoundingClientRect() { return this._rect ?? { left: 0, top: 0, width: 0, height: 0 }; }
}

function makeDom() {
  return {
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    activeElement: null
  };
}

test("FIN-05B screen-dom drags, resizes and routes keyboard through the pure model", async () => {
  const { mountScreenComposition } = await import("../dist/src/screen-dom.js");
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = makeDom();
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  try {
    const container = new FakeElement("div");
    const calls = { selections: [], transforms: [], commits: [], nudges: [], actions: [] };
    const handle = mountScreenComposition(container, {
      screen: screenForNode(mission(), "s1"),
      defaults: mission().defaults,
      editable: true,
      selectedLayerId: "l1",
      onSelect: (id) => calls.selections.push(id),
      onTransform: (id, t) => calls.transforms.push([id, t.x, t.y, t.scale]),
      onCommit: (id, t) => calls.commits.push([id, t.x, t.y, t.scale]),
      onNudge: (id, dx, dy) => calls.nudges.push([id, dx, dy]),
      onAction: (action, id) => calls.actions.push([action, id])
    });

    const stage = container.querySelector(".screen-stage");
    stage._rect = { left: 0, top: 0, width: 800, height: 450 };
    const layers = container.querySelectorAll(".screen-layer");
    assert.equal(layers.length, 2, "both layers rendered");
    const l1El = layers.find((el) => el.dataset.layerId === "l1");
    assert.ok(l1El, "layer element carries its id");

    // drag l1 to the middle-right
    const listeners = {};
    globalThis.window = { addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); }, removeEventListener: (type, fn) => { const list = listeners[type]; const i = list?.indexOf(fn) ?? -1; if (i >= 0) list.splice(i, 1); } };
    stage.dispatch("pointerdown", { target: l1El, clientX: 400, clientY: 225, button: 0, preventDefault() {} });
    assert.deepEqual(calls.selections.at(-1), "l1");
    for (const fn of listeners.pointermove ?? []) fn({ clientX: 600, clientY: 90 });
    for (const fn of listeners.pointerup ?? []) fn({});
    assert.equal(calls.commits.length, 1, "one commit after the drag");
    const [, cx, cy] = calls.commits[0];
    assert.ok(Math.abs(cx - 0.75) < 1e-9 && Math.abs(cy - 0.2) < 1e-9, `drag moved the layer: ${cx},${cy}`);

    // resize from the handle
    const resizeHandle = container.querySelector(".screen-resize-handle");
    assert.ok(resizeHandle, "resize handle exists for the selection");
    stage.dispatch("pointerdown", { target: resizeHandle, clientX: 450, clientY: 225, button: 0, preventDefault() {} });
    const before = calls.commits.length;
    for (const fn of listeners.pointermove ?? []) fn({ clientX: 700, clientY: 225 });
    for (const fn of listeners.pointerup ?? []) fn({});
    assert.equal(calls.commits.length, before + 1, "resize commits");
    assert.ok(calls.commits.at(-1)[3] > 1, "scale grew");

    // keyboard
    handle.select("l2");
    stage.dispatch("keydown", { key: "ArrowRight", preventDefault() {} });
    assert.deepEqual(calls.nudges.at(-1), ["l2", 0.01, 0]);
    stage.dispatch("keydown", { key: "]", preventDefault() {} });
    assert.deepEqual(calls.actions.at(-1), ["forward", "l2"]);
    stage.dispatch("keydown", { key: "Delete", preventDefault() {} });
    assert.deepEqual(calls.actions.at(-1), ["delete", "l2"]);
    stage.dispatch("keydown", { key: "Escape", preventDefault() {} });
    assert.deepEqual(calls.selections.at(-1), null);
    handle.destroy();
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test("FIN-05B screen composition persists through canonical /mission without a new write path", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { SQLiteControlStore, SQLiteControlReleaseStore } = await import("../../../packages/control/dist/index.js");
  const { buildPluginRegistry } = await import("../../../packages/plugins/dist/index.js");
  const { DICE_CHECK_MANIFEST } = await import("../../../packages/plugins/dist/dice-check.js");
  const { createControlHttpServer } = await import("../../server/dist/control-server.js");
  const { ControlApiClient } = await import("../dist/src/api.js");
  const { createStudioDevServer } = await import("../dist/src/dev-server.js");
  const { createInitialLocationBlock } = await import("../dist/src/forms.js");

  const dir = await mkdtemp(join(tmpdir(), "living-history-fin05b-"));
  const path = join(dir, "control.sqlite");
  const store = new SQLiteControlStore({ path });
  const releaseStore = new SQLiteControlReleaseStore({ path });
  const registry = buildPluginRegistry([DICE_CHECK_MANIFEST]);
  assert.equal(registry.ok, true);
  const control = createControlHttpServer({ store, releases: { store: releaseStore, pluginRegistry: registry.registry, nowMs: () => 1000 } });
  const controlAddress = await control.listen(0, "127.0.0.1");
  const studio = createStudioDevServer({ controlOrigin: `http://127.0.0.1:${controlAddress.port}` });
  const studioAddress = await studio.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${studioAddress.port}`;
  const api = new ControlApiClient((input, init) => fetch(new URL(String(input), origin), init));
  try {
    await api.createProject({ projectId: "fin05b-project", title: "FIN-05B" });
    await api.createQuest({
      projectId: "fin05b-project", questId: "fin05b-quest", title: "FIN-05B",
      entryLocationId: "s1", initialBlocks: [createInitialLocationBlock("s1", "Старт")]
    });
    const created = await api.saveMission("fin05b-project", "fin05b-quest", 0, { ...mission(), projectId: "fin05b-project", questId: "fin05b-quest" });
    const doc = created.mission;

    const added = addScreenLayer(doc, "s1", layer("l3", { x: 0.1, y: 0.9, scale: 1.4, rotation: 30, z: 3 }));
    assert.equal(added.ok, true);
    const saved = await api.saveMission("fin05b-project", "fin05b-quest", doc.contentRevision, added.mission);
    const persisted = saved.mission.screens.scenes.s1.layers.find((entry) => entry.id === "l3");
    assert.ok(persisted, "layer persisted through the real Control server");
    assert.deepEqual([persisted.x, persisted.scale, persisted.rotation], [0.1, 1.4, 30]);

    const edited = updateScreenLayer(saved.mission, "s1", "l3", { x: 0.5, y: 0.5, scale: 2, opacity: 0.5 });
    assert.equal(edited.ok, true);
    const savedEdit = await api.saveMission("fin05b-project", "fin05b-quest", saved.mission.contentRevision, edited.mission);
    const reloaded = await api.getMission("fin05b-project", "fin05b-quest");
    const finalLayer = reloaded.screens.scenes.s1.layers.find((entry) => entry.id === "l3");
    assert.deepEqual([finalLayer.x, finalLayer.scale, finalLayer.opacity], [0.5, 2, 0.5]);
    assert.equal(reloaded.contentRevision, savedEdit.mission.contentRevision);
  } finally {
    await studio.close();
    await control.close();
    releaseStore.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
