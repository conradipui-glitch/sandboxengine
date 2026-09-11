import test from "node:test";
import assert from "node:assert/strict";

import {
  addStoryScene,
  duplicateStoryChoice,
  duplicateStoryEnding,
  duplicateStoryScene,
  missionToStoryBoard,
  removeStoryNode,
  renameStoryChoice,
  storyDeletionImpact,
  storyEdgeCaption,
  storyRendererPositions
} from "../dist/src/story-model.js";
import {
  STORY_CONNECT_LABEL,
  STORY_FIT_LABEL,
  STORY_MAX_SCALE,
  STORY_MIN_SCALE,
  clampStoryScale,
  fitStoryViewport,
  storyKeyAction,
  StoryHistory,
  zoomStoryViewportAt
} from "../dist/src/story-commands.js";
import { missionContentHash, validateMissionDraft } from "../../../packages/contracts/dist/index.js";
import { StudioApp } from "../dist/src/app.js";

// StudioApp.render() читает document.activeElement; браузера в тестах нет.
globalThis.document ??= { activeElement: null };
globalThis.HTMLElement ??= class {};

function mission() {
  return {
    schemaVersion: "1.0",
    projectId: "project",
    questId: "quest",
    contentRevision: 1,
    contentHash: "c".repeat(64),
    listing: {
      title: "Депо",
      slug: "depo",
      summary: "",
      coverAssetId: null,
      period: "",
      place: "",
      playerRole: "",
      estimatedMinutes: 10,
      supportedModes: ["choice"]
    },
    story: {
      entrySceneId: "depot",
      scenes: [
        {
          id: "depot", title: "Депо", text: "Ночь.", dialogue: [{ id: "d1", speakerId: null, text: "Тишина." }],
          choices: [
            { id: "c1", label: "На пути", targetSceneId: "tracks", endingId: null, conditions: [], effects: [] },
            { id: "c2", label: "Финал сразу", targetSceneId: null, endingId: "lost", conditions: [], effects: [] }
          ]
        },
        {
          id: "tracks", title: "Пути", text: "Тупик.", dialogue: [],
          choices: [{ id: "c3", label: "Открыть", targetSceneId: null, endingId: "found", conditions: [], effects: [] }]
        }
      ],
      endings: [
        { id: "found", title: "Найден", text: "Ящики." },
        { id: "lost", title: "Потерян", text: "Рассвело." }
      ]
    },
    screens: { intros: [], scenes: {}, endings: {} },
    defaults: { background: null, theme: "", animationPreset: "" }
  };
}

function withStory(story) {
  return { ...mission(), story };
}

test("FIN-05 edges carry the decision text and the transition target caption", () => {
  const model = missionToStoryBoard(mission(), new Map());
  const depotTracks = model.edges.find((edge) => edge.source === "depot" && edge.target === "tracks");
  assert.equal(depotTracks.label, "На пути");
  assert.equal(depotTracks.targetTitle, "Пути");
  assert.equal(storyEdgeCaption(depotTracks), "На пути → Пути");
  const toEnding = model.edges.find((edge) => edge.target === "lost");
  assert.equal(storyEdgeCaption(toEnding), "Финал сразу → Потерян");
});

test("FIN-05 duplicate scene generates new scene/dialogue/choice IDs and rewires self references", () => {
  // self reference: depot -> depot needs a choice that points at its own scene
  const doc = mission();
  doc.story.scenes[0].choices.push({ id: "self", label: "Остаться", targetSceneId: "depot", endingId: null, conditions: [], effects: [] });
  const result = duplicateStoryScene(doc, "depot", "depot-copy");
  assert.equal(result.ok, true, JSON.stringify(result));
  const copy = result.story.scenes.find((scene) => scene.id === "depot-copy");
  assert.ok(copy, "copy exists");
  assert.match(copy.title, /Депо/);
  assert.equal(copy.text, "Ночь.");
  assert.equal(copy.dialogue.length, 1);
  assert.notEqual(copy.dialogue[0].id, "d1");
  assert.equal(copy.choices.length, 3);
  assert.ok(copy.choices.every((choice) => choice.id !== "c1" && choice.id !== "c2" && choice.id !== "self"));
  const copiedSelf = copy.choices.find((choice) => choice.label === "Остаться");
  assert.equal(copiedSelf.targetSceneId, "depot-copy", "self reference follows the copy");
  const copiedToTracks = copy.choices.find((choice) => choice.label === "На пути");
  assert.equal(copiedToTracks.targetSceneId, "tracks", "external reference stays");
  // original untouched
  assert.equal(doc.story.scenes.length, 2);
  assert.equal(doc.story.scenes[0].choices[0].targetSceneId, "tracks");
  assert.equal(result.story.entrySceneId, "depot");
});

test("FIN-05 duplicate scene/ending rejects missing source and taken id", () => {
  assert.equal(duplicateStoryScene(mission(), "void", "x").error, "story.node_missing");
  assert.equal(duplicateStoryScene(mission(), "depot", "found").error, "story.id_taken");
  assert.equal(duplicateStoryEnding(mission(), "void", "x").error, "story.node_missing");
  const ok = duplicateStoryEnding(mission(), "found", "found-copy");
  assert.equal(ok.ok, true);
  assert.equal(ok.story.endings.length, 3);
  assert.equal(ok.story.endings[2].id, "found-copy");
  assert.match(ok.story.endings[2].title, /Найден/);
});

test("FIN-05 choice duplicate/rename keep a single valid target", () => {
  const dup = duplicateStoryChoice(mission(), "depot", "c1", "c1-copy");
  assert.equal(dup.ok, true);
  const scene = dup.story.scenes.find((entry) => entry.id === "depot");
  assert.equal(scene.choices.length, 3);
  const copy = scene.choices.find((choice) => choice.id === "c1-copy");
  assert.equal(copy.targetSceneId, "tracks");
  assert.equal(duplicateStoryChoice(mission(), "depot", "void", "x").error, "story.choice_missing");
  assert.equal(duplicateStoryChoice(mission(), "depot", "c1", "c2").error, "story.choice_id_taken");

  const renamed = renameStoryChoice(mission(), "depot", "c1", "По рельсам");
  assert.equal(renamed.ok, true);
  assert.equal(renamed.story.scenes[0].choices[0].label, "По рельсам");
  assert.equal(renamed.story.scenes[0].choices[0].targetSceneId, "tracks");
  assert.equal(renameStoryChoice(mission(), "depot", "c1", "  ").error, "story.label_empty");
  assert.equal(renameStoryChoice(mission(), "depot", "void", "x").error, "story.choice_missing");
});

test("FIN-05 deletion impact names the referencing choices before a destructive delete", () => {
  const impact = storyDeletionImpact(mission(), "tracks");
  assert.equal(impact.exists, true);
  assert.equal(impact.safeToDelete, false);
  assert.deepEqual(impact.referencedBy.map((ref) => [ref.sceneId, ref.choiceId, ref.label]), [["depot", "c1", "На пути"]]);
  const endingImpact = storyDeletionImpact(mission(), "found");
  assert.equal(endingImpact.referencedBy.length, 1);
  assert.equal(endingImpact.referencedBy[0].choiceId, "c3");
  const entryImpact = storyDeletionImpact(mission(), "depot");
  assert.equal(entryImpact.isEntry, true);
  assert.equal(entryImpact.safeToDelete, false);
  // unreferenced scene is safe
  const orphan = mission();
  orphan.story.scenes[0].choices = [];
  orphan.story.scenes[1].choices = [];
  assert.equal(storyDeletionImpact(orphan, "tracks").safeToDelete, true);
  assert.equal(storyDeletionImpact(mission(), "void").exists, false);
  // removeStoryNode still fails closed exactly when impact is unsafe
  assert.equal(removeStoryNode(mission(), "tracks").error, "story.node_referenced");
});

test("FIN-05 fit-all frames every node deterministically and clamps scale", () => {
  assert.deepEqual(fitStoryViewport([], { width: 800, height: 600 }), { scale: 1, panX: 0, panY: 0 });
  const nodes = [{ x: 0, y: 0 }, { x: 1000, y: 400 }];
  const view = fitStoryViewport(nodes, { width: 800, height: 600 });
  assert.ok(view.scale > 0 && view.scale <= 1);
  assert.ok(Number.isFinite(view.panX) && Number.isFinite(view.panY));
  assert.deepEqual(view, fitStoryViewport(nodes, { width: 800, height: 600 }));
  // computed frame keeps all content inside the viewport
  for (const node of nodes) {
    const cx = node.x * view.scale + view.panX;
    const cy = node.y * view.scale + view.panY;
    assert.ok(cx >= -1 && cx <= 800 + 1, `node x visible: ${cx}`);
    assert.ok(cy >= -1 && cy <= 600 + 1, `node y visible: ${cy}`);
  }
  const tiny = fitStoryViewport([{ x: 0, y: 0 }, { x: 100000, y: 100000 }], { width: 100, height: 100 });
  assert.equal(tiny.scale, STORY_MIN_SCALE);
});

test("FIN-05 zoom keeps the world point under the cursor fixed and clamps", () => {
  const view = { scale: 1, panX: 20, panY: 30 };
  const cursor = { x: 240, y: 180 };
  const world = { x: (cursor.x - view.panX) / view.scale, y: (cursor.y - view.panY) / view.scale };
  const zoomedIn = zoomStoryViewportAt(view, 1.1, cursor);
  assert.ok(zoomedIn.scale > view.scale);
  assert.ok(Math.abs((cursor.x - zoomedIn.panX) / zoomedIn.scale - world.x) < 1e-9);
  assert.ok(Math.abs((cursor.y - zoomedIn.panY) / zoomedIn.scale - world.y) < 1e-9);
  let clamped = view;
  for (let i = 0; i < 40; i += 1) clamped = zoomStoryViewportAt(clamped, 1.5, cursor);
  assert.equal(clamped.scale, STORY_MAX_SCALE);
  let down = view;
  for (let i = 0; i < 40; i += 1) down = zoomStoryViewportAt(down, 1 / 1.5, cursor);
  assert.equal(down.scale, STORY_MIN_SCALE);
  assert.equal(clampStoryScale(Number.NaN), 1);
});

test("FIN-05 keyboard shortcuts map to undo/redo/delete/fit/deselect", () => {
  assert.equal(storyKeyAction({ key: "z", ctrlKey: true }), "undo");
  assert.equal(storyKeyAction({ key: "z", metaKey: true }), "undo");
  assert.equal(storyKeyAction({ key: "z", ctrlKey: true, shiftKey: true }), "redo");
  assert.equal(storyKeyAction({ key: "y", ctrlKey: true }), "redo");
  assert.equal(storyKeyAction({ key: "Delete" }), "delete");
  assert.equal(storyKeyAction({ key: "Backspace" }), "delete");
  assert.equal(storyKeyAction({ key: "f" }), "fit");
  assert.equal(storyKeyAction({ key: "F" }), "fit");
  assert.equal(storyKeyAction({ key: "Escape" }), "deselect");
  assert.equal(storyKeyAction({ key: "a" }), null);
  assert.equal(storyKeyAction({ key: "Delete", ctrlKey: true }), null);
  assert.equal(STORY_FIT_LABEL, "Вписать всё");
  assert.equal(STORY_CONNECT_LABEL, "Связать");
});

test("FIN-05 story history supports undo and redo without losing the other stack", () => {
  const history = new StoryHistory();
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
  history.push("v1");
  history.push("v2");
  assert.equal(history.canUndo, true);
  assert.equal(history.depth, 2);
  assert.equal(history.undo("v3"), "v2");
  assert.equal(history.canRedo, true);
  assert.equal(history.undo("v2"), "v1");
  assert.equal(history.canUndo, false);
  assert.equal(history.undo("v1"), null);
  assert.equal(history.redo("v1"), "v2");
  assert.equal(history.redo("v2"), "v3");
  assert.equal(history.canRedo, false);
  assert.equal(history.redo("v3"), null);
  // a new edit after undo clears redo
  history.clear();
  history.push("a");
  history.undo("b");
  history.push("b");
  assert.equal(history.canRedo, false);
});

test("FIN-05 board layout never changes the game content hash", async () => {
  const doc = mission();
  assert.deepEqual(validateMissionDraft(doc), []);
  const before = await missionContentHash(doc);
  const layoutA = storyRendererPositions(new Map([["story:depot", { x: 10, y: 20 }]]));
  const layoutB = storyRendererPositions(new Map([["story:depot", { x: 900, y: 800 }], ["story:tracks", { x: 5, y: 5 }]]));
  const boardA = missionToStoryBoard(doc, layoutA);
  const boardB = missionToStoryBoard(doc, layoutB);
  assert.notDeepEqual([boardA.positions.get("depot")], [boardB.positions.get("depot")]);
  const after = await missionContentHash(doc);
  assert.equal(after, before, "layout is view-only and must not touch the content hash");

  // sanity: a real story mutation does change the hash
  const added = addStoryScene(doc, { id: "extra", title: "Склад" });
  assert.equal(added.ok, true);
  const mutated = await missionContentHash(withStory(added.story));
  assert.notEqual(mutated, before, "story content is part of the hash");
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

function bootStoryApp(nodeId) {
  const root = fakeRoot();
  const app = new StudioApp(root, { async listProjects() { return []; } });
  app.state.access = Object.freeze({
    mode: "local-owner", auth: null, mutationProof: true, members: null, membersError: null
  });
  app.state.view = "editor";
  app.state.projects = Object.freeze([{ projectId: "p", title: "Проект", role: "owner" }]);
  app.state.selectedProjectId = "p";
  app.state.selectedQuestId = "q";
  app.state.quests = Object.freeze([{
    projectId: "p", questId: "q", draftRevision: 1, title: "Квест", entryLocationId: "depot", contentHash: "x".repeat(64)
  }]);
  app.state.draft = Object.freeze({
    projectId: "p", questId: "q", draftRevision: 1, title: "Квест", entryLocationId: "depot",
    contentHash: "x".repeat(64), blocks: Object.freeze([])
  });
  app.state.mission = mission();
  app.state.missionRevision = 1;
  app.state.boardView = "story";
  app.state.selectedStoryNodeId = nodeId;
  app.render();
  return { app, root };
}

test("FIN-05 Studio story bar exposes redo, duplicate, choice rename and the keyboard hint", () => {
  const { app, root } = bootStoryApp("depot");
  assert.match(root.innerHTML, /data-action="story-redo"/);
  assert.match(root.innerHTML, /data-action="story-duplicate-node"/);
  assert.match(root.innerHTML, /data-form="story-choice-edit"/);
  assert.match(root.innerHTML, /data-action="story-duplicate-choice"/);
  assert.match(root.innerHTML, /Ctrl\+Shift\+Z/);
  assert.match(root.innerHTML, /«Вписать всё»/);
  // no undo history yet -> undo disabled, redo disabled
  assert.match(root.innerHTML, /data-action="story-undo" disabled/);
  assert.match(root.innerHTML, /data-action="story-redo" disabled/);

  // an undoable snapshot enables undo; undoing moves it into the redo stack
  app.state.storyHistory.push(mission());
  app.render();
  assert.doesNotMatch(root.innerHTML, /data-action="story-undo" disabled/);
  app.state.storyHistory.undo(mission());
  app.render();
  assert.doesNotMatch(root.innerHTML, /data-action="story-redo" disabled/);
  assert.match(root.innerHTML, /data-action="story-undo" disabled/);
});

test("FIN-05 Studio warns about referencing choices before deleting a linked scene", () => {
  const { root } = bootStoryApp("tracks");
  assert.match(root.innerHTML, /story-delete-warning/);
  assert.match(root.innerHTML, /«На пути»/);
  const entry = bootStoryApp("depot");
  assert.match(entry.root.innerHTML, /Входную сцену удалить нельзя/);
});

test("FIN-05 Studio keeps the story history as the tested StoryHistory integration", () => {
  const { app } = bootStoryApp("depot");
  assert.ok(app.state.storyHistory instanceof StoryHistory, "app uses the same history class");
});

// --- Минимальный DOM-шим: проверяем реальный story-dom.ts без браузера ---

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
        if (attrMatch) ok = child.attributes[attrMatch[1]] === attrMatch[2];
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
  const root = new FakeElement("body");
  return {
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    activeElement: null,
    _root: root
  };
}

test("FIN-05 story-dom renders decision+transition captions, 'Вписать всё', zoom-to-cursor and keyboard", async () => {
  const { mountStoryBoard } = await import("../dist/src/story-dom.js");
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = makeDom();
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  try {
    const container = new FakeElement("div");
    const calls = { undo: 0, redo: 0, deletes: [], selections: [] };
    const model = missionToStoryBoard(mission(), new Map());
    const handle = mountStoryBoard(container, {
      model,
      editable: true,
      onUndo: () => { calls.undo += 1; },
      onRedo: () => { calls.redo += 1; },
      onDelete: (id) => calls.deletes.push(id),
      onSelect: (id) => calls.selections.push(id)
    });

    const viewport = container.querySelector(".story-viewport");
    viewport._rect = { left: 0, top: 0, width: 800, height: 600 };
    const world = container.querySelector(".story-world");

    const labels = container.querySelectorAll(".story-edge-label").map((el) => el.textContent);
    assert.ok(labels.includes("На пути → Пути"), `edge caption shows decision -> transition: ${labels.join(" | ")}`);
    assert.ok(labels.includes("Финал сразу → Потерян"));

    const buttons = container.querySelectorAll("button");
    assert.ok(buttons.some((b) => b.textContent === STORY_FIT_LABEL), "fit button uses Вписать всё");
    assert.ok(buttons.some((b) => b.textContent === STORY_CONNECT_LABEL), "connect button label");

    handle.fit();
    const fitted = world.style.transform;
    assert.match(fitted, /scale\(/);
    const wheel = { deltaY: -1, clientX: 400, clientY: 300, preventDefault() {} };
    viewport.dispatch("wheel", wheel);
    assert.notEqual(world.style.transform, fitted, "wheel zoom changed the view");
    const scaleOf = (transform) => Number(/scale\(([^)]+)\)/.exec(transform)?.[1] ?? "0");
    assert.ok(scaleOf(world.style.transform) > scaleOf(fitted), "zoom in increased scale");

    const zoomed = world.style.transform;
    viewport.dispatch("keydown", { key: "f", preventDefault() {} });
    // fit recomputes deterministically; still a valid view
    assert.match(world.style.transform, /scale\(/);
    assert.ok(zoomed.length > 0);

    handle.select("depot");
    viewport.dispatch("keydown", { key: "z", ctrlKey: true, preventDefault() {} });
    assert.equal(calls.undo, 1);
    viewport.dispatch("keydown", { key: "z", ctrlKey: true, shiftKey: true, preventDefault() {} });
    assert.equal(calls.redo, 1);
    viewport.dispatch("keydown", { key: "Delete", preventDefault() {} });
    assert.deepEqual(calls.deletes, ["depot"]);
    viewport.dispatch("keydown", { key: "Escape", preventDefault() {} });
    assert.equal(calls.selections.at(-1), null);
    handle.destroy();
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test("FIN-05 story mutations persist through canonical /mission and board layout keeps the hash", async () => {
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

  const dir = await mkdtemp(join(tmpdir(), "living-history-fin05-"));
  const path = join(dir, "control.sqlite");
  const store = new SQLiteControlStore({ path });
  const releaseStore = new SQLiteControlReleaseStore({ path });
  const registry = buildPluginRegistry([DICE_CHECK_MANIFEST]);
  assert.equal(registry.ok, true);
  const control = createControlHttpServer({
    store,
    releases: { store: releaseStore, pluginRegistry: registry.registry, nowMs: () => 1000 }
  });
  const controlAddress = await control.listen(0, "127.0.0.1");
  const studio = createStudioDevServer({ controlOrigin: `http://127.0.0.1:${controlAddress.port}` });
  const studioAddress = await studio.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${studioAddress.port}`;
  const api = new ControlApiClient((input, init) => fetch(new URL(String(input), origin), init));
  try {
    await api.createProject({ projectId: "fin05-project", title: "FIN-05" });
    await api.createQuest({
      projectId: "fin05-project", questId: "fin05-quest", title: "FIN-05",
      entryLocationId: "start", initialBlocks: [createInitialLocationBlock("start", "Старт")]
    });
    const created = await api.saveMission("fin05-project", "fin05-quest", 0, {
      ...mission(), projectId: "fin05-project", questId: "fin05-quest"
    });
    assert.equal(created.mission.contentRevision, 1);
    assert.equal(created.mission.contentHash.length, 64);

    const doc = created.mission;
    const dup = duplicateStoryScene(doc, "depot", "scene-copy");
    assert.equal(dup.ok, true);
    const saved = await api.saveMission("fin05-project", "fin05-quest", doc.contentRevision, { ...doc, story: dup.story });
    const copy = saved.mission.story.scenes.find((scene) => scene.id === "scene-copy");
    assert.ok(copy, "duplicate scene persisted through the real Control server");
    assert.equal(copy.choices.length, 2);

    const renamed = renameStoryChoice(saved.mission, "depot", "c1", "По рельсам");
    const renamedSaved = await api.saveMission("fin05-project", "fin05-quest", saved.mission.contentRevision, {
      ...saved.mission, story: renamed.story
    });
    assert.equal(renamedSaved.mission.story.scenes.find((scene) => scene.id === "depot").choices[0].label, "По рельсам");

    const hashBefore = renamedSaved.mission.contentHash;
    const revisionBefore = renamedSaved.mission.contentRevision;
    const board = await api.applyBoardChanges("fin05-project", "fin05-quest", 0, {
      "story:depot": { x: 12, y: 34 },
      "story:scene-copy": { x: 500, y: 120 }
    });
    assert.deepEqual(board.positions["story:depot"], { x: 12, y: 34 });
    const after = await api.getMission("fin05-project", "fin05-quest");
    assert.equal(after.contentHash, hashBefore, "layout write must not change the game content hash");
    assert.equal(after.contentRevision, revisionBefore, "layout write must not create a story revision");
  } finally {
    await studio.close();
    await control.close();
    releaseStore.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
