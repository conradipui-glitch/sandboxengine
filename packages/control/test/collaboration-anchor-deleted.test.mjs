import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteControlStore } from "../dist/index.js";

const workshop = Object.freeze({ schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: Object.freeze({}) });
const forward = Object.freeze({ schemaVersion: "1.0", id: "forward", kind: "core.location", title: "Вперёд", description: "", data: Object.freeze({}) });

async function makeStore(extraBlocks = []) {
  const dir = await mkdtemp(join(tmpdir(), "living-history-anchor-deleted-"));
  const path = join(dir, "control.sqlite");
  const store = new SQLiteControlStore({ path });
  await store.createProject({ projectId: "p1", title: "Проект" });
  await store.createQuest({
    projectId: "p1",
    questId: "q1",
    title: "Квест",
    entryLocationId: "workshop",
    initialBlocks: [workshop, forward, ...extraBlocks]
  });
  return { dir, path, store };
}

async function dispose(dir, store) {
  store.close();
  await rm(dir, { recursive: true, force: true });
}

async function anchorThread(store, key, anchor) {
  const created = await store.createThread("p1", "q1", {
    anchor,
    text: `Тред ${key}`,
    idempotencyKey: key,
    actorUserId: "author-1"
  });
  assert.equal(created.kind, "created", `тред ${key} должен создаться`);
  return created.view.threads.find((entry) => entry.anchor.kind === anchor.kind && entry.anchor.targetId === anchor.targetId);
}

function threadByTarget(view, targetId) {
  return view.threads.find((entry) => entry.anchor.targetId === targetId);
}

test("FIN-12 anchorDeleted: layer/field anchors of a present block are not «deleted»", async () => {
  const { dir, store } = await makeStore();
  try {
    await anchorThread(store, "t-scene", { kind: "scene", targetId: "forward", position: null });
    await anchorThread(store, "t-layer", { kind: "layer", targetId: "forward.layer-1", position: null });
    await anchorThread(store, "t-field", { kind: "field", targetId: "forward.title", position: null });
    await anchorThread(store, "t-bare-layer", { kind: "layer", targetId: "bg", position: null });
    await anchorThread(store, "t-namespaced-field", { kind: "field", targetId: "scenes.workshop.title", position: null });
    await anchorThread(store, "t-board", { kind: "board", targetId: null, position: { x: 1, y: 2 } });

    const view = await store.getCollaboration("p1", "q1");

    // (1) layer anchor of an existing block
    assert.equal(threadByTarget(view, "forward.layer-1").anchorDeleted, false, "слой существующего блока не удалён");
    // (2) field anchor of an existing block
    assert.equal(threadByTarget(view, "forward.title").anchorDeleted, false, "поле существующего блока не удалено");
    // (3) scene anchor of an existing block
    assert.equal(threadByTarget(view, "forward").anchorDeleted, false, "сцена существующего блока не удалена");
    // honest "unknown" stays false — never a false «удалён»
    assert.equal(threadByTarget(view, "bg").anchorDeleted, false, "неразрешимый, но валидный targetId — не «удалён»");
    assert.equal(threadByTarget(view, "scenes.workshop.title").anchorDeleted, false, "пространство имён документа — не «удалён»");
    assert.equal(threadByTarget(view, null).anchorDeleted, false, "пин на доске не «удалён»");

    // (4) a genuinely removed block must still be reported as deleted
    const draft = await store.getDraft("p1", "q1");
    const removal = await store.applyDraftChanges("p1", "q1", {
      baseRevision: draft.draftRevision,
      changes: [{ kind: "block.remove", blockId: "forward" }]
    });
    assert.equal(removal.kind, "updated");

    const after = await store.getCollaboration("p1", "q1");
    assert.equal(threadByTarget(after, "forward").anchorDeleted, true, "удалённый блок — «удалён»");
    assert.equal(threadByTarget(after, "forward.layer-1").anchorDeleted, true, "слой в удалённом блоке — «удалён»");
    assert.equal(threadByTarget(after, "forward.title").anchorDeleted, true, "поле в удалённом блоке — «удалён»");
    assert.equal(threadByTarget(after, "bg").anchorDeleted, false, "неразрешимый targetId остаётся «не удалён»");
    assert.equal(threadByTarget(after, null).anchorDeleted, false, "доска остаётся «не удалена»");
  } finally {
    await dispose(dir, store);
  }
});

function missionDoc() {
  return {
    schemaVersion: "1.0",
    projectId: "p1",
    questId: "q1",
    contentRevision: 0,
    contentHash: "",
    listing: {
      title: "Пропавший груз",
      slug: "propavshiy-gruz",
      summary: "Найти груз.",
      coverAssetId: null,
      period: "1917",
      place: "Станция",
      playerRole: "Кладовщик",
      estimatedMinutes: 20,
      supportedModes: ["choice"]
    },
    story: {
      entrySceneId: "depot",
      scenes: [
        { id: "depot", title: "Депо", text: "Ночь.", dialogue: [], choices: [{ id: "c1", label: "Пути", targetSceneId: "tracks", endingId: null, conditions: [], effects: [] }] },
        { id: "tracks", title: "Пути", text: "Тупик.", dialogue: [], choices: [{ id: "c2", label: "Ящики", targetSceneId: null, endingId: "found", conditions: [], effects: [] }] }
      ],
      endings: [{ id: "found", title: "Найден", text: "Ящики." }]
    },
    screens: {
      intros: [],
      scenes: {
        depot: { background: null, inheritBackground: false, music: null, layers: [{ id: "layer-1", kind: "text", name: "Подпись", visible: true, locked: false, asset: null, x: 0, y: 0, scale: 1, rotation: 0, flipH: false, flipV: false, opacity: 1, z: 1 }] }
      },
      endings: {}
    },
    defaults: { background: null, theme: "station-night", animationPreset: "calm" }
  };
}

test("FIN-12 anchorDeleted: layer/field/scene anchors resolve against the mission document", async () => {
  const { dir, store } = await makeStore();
  try {
    const saved = await store.saveMission("p1", "q1", {
      baseRevision: 0,
      mission: missionDoc(),
      idempotencyKey: "mission-1",
      actorUserId: "owner"
    });
    assert.equal(saved.kind, "saved");

    await anchorThread(store, "m-scene", { kind: "scene", targetId: "depot", position: null });
    await anchorThread(store, "m-layer", { kind: "layer", targetId: "layer-1", position: null });
    await anchorThread(store, "m-scoped-layer", { kind: "layer", targetId: "depot.layer-1", position: null });
    await anchorThread(store, "m-field", { kind: "field", targetId: "depot.title", position: null });
    await anchorThread(store, "m-ending", { kind: "scene", targetId: "found", position: null });

    const view = await store.getCollaboration("p1", "q1");
    assert.equal(threadByTarget(view, "depot").anchorDeleted, false, "сцена существующей миссии не удалена");
    assert.equal(threadByTarget(view, "layer-1").anchorDeleted, false, "слой, известный из документа, не удалён");
    assert.equal(threadByTarget(view, "depot.layer-1").anchorDeleted, false, "слой внутри существующей сцены не удалён");
    assert.equal(threadByTarget(view, "depot.title").anchorDeleted, false, "поле существующей сцены не удалено");
    assert.equal(threadByTarget(view, "found").anchorDeleted, false, "существующая концовка не удалена");

    // A scene id that is nowhere in the mission document is a genuine deletion.
    await anchorThread(store, "m-missing-scene", { kind: "scene", targetId: "vanished", position: null });
    const after = await store.getCollaboration("p1", "q1");
    assert.equal(threadByTarget(after, "vanished").anchorDeleted, true, "несуществующая сцена — «удалена»");
  } finally {
    await dispose(dir, store);
  }
});

test("FIN-12 anchorDeleted: flag follows the block lifecycle (present → removed → restored)", async () => {
  const { dir, store } = await makeStore();
  try {
    await anchorThread(store, "rt-layer", { kind: "layer", targetId: "forward.layer-1", position: null });

    const before = await store.getCollaboration("p1", "q1");
    assert.equal(threadByTarget(before, "forward.layer-1").anchorDeleted, false);

    const draft = await store.getDraft("p1", "q1");
    const removal = await store.applyDraftChanges("p1", "q1", {
      baseRevision: draft.draftRevision,
      changes: [{ kind: "block.remove", blockId: "forward" }]
    });
    assert.equal(removal.kind, "updated");
    assert.equal(threadByTarget(await store.getCollaboration("p1", "q1"), "forward.layer-1").anchorDeleted, true);

    const restored = await store.applyDraftChanges("p1", "q1", {
      baseRevision: removal.draft.draftRevision,
      changes: [{ kind: "block.add", block: forward }]
    });
    assert.equal(restored.kind, "updated");
    assert.equal(threadByTarget(await store.getCollaboration("p1", "q1"), "forward.layer-1").anchorDeleted, false,
      "вернувшийся блок снимает «удалён»");
  } finally {
    await dispose(dir, store);
  }
});
