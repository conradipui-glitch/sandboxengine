// Regression tests for review items R-33 (anchorDeleted resolved by anchor kind)
// and R-34 (mission-session creation idempotency is per participant).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteControlStore } from "../dist/index.js";

const workshop = Object.freeze({ schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: Object.freeze({}) });
const forward = Object.freeze({ schemaVersion: "1.0", id: "forward", kind: "core.location", title: "Вперёд", description: "", data: Object.freeze({}) });

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), "living-history-review-control-"));
  const path = join(dir, "control.sqlite");
  const store = new SQLiteControlStore({ path });
  await store.createProject({ projectId: "p1", title: "Проект" });
  await store.createQuest({
    projectId: "p1",
    questId: "q1",
    title: "Квест",
    entryLocationId: "workshop",
    initialBlocks: [workshop, forward]
  });
  return { dir, store };
}

async function dispose(dir, store) {
  store.close();
  await rm(dir, { recursive: true, force: true });
}

function emptyWorld() {
  return {
    schemaVersion: "1.0",
    revision: 0,
    clock: { elapsedSeconds: 0 },
    locations: [],
    entities: [],
    resources: [],
    items: [],
    terminal: null
  };
}

// Scenes "depot"/"tracks" and ending "found". Note: there is deliberately NO
// scene named "forward" — a draft block with that id exists instead.
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
    screens: { intros: [], scenes: {}, endings: {} },
    defaults: { background: null, theme: "station-night", animationPreset: "calm" }
  };
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

function byTarget(view, targetId) {
  return view.threads.find((entry) => entry.anchor.targetId === targetId);
}

test("R-33 anchorDeleted: resolved by anchor kind — layer/field never die from the block set, scene follows its own id space", async () => {
  const { dir, store } = await makeStore();
  try {
    await anchorThread(store, "r33-layer-bare", { kind: "layer", targetId: "bg", position: null });
    await anchorThread(store, "r33-field-ns", { kind: "field", targetId: "scenes.workshop.title", position: null });
    await anchorThread(store, "r33-layer-scoped", { kind: "layer", targetId: "forward.layer-1", position: null });
    await anchorThread(store, "r33-scene", { kind: "scene", targetId: "forward", position: null });
    await anchorThread(store, "r33-board", { kind: "board", targetId: null, position: { x: 7, y: 8 } });

    // --- no mission document yet: scene falls back to draft block ids ---
    const beforeMission = await store.getCollaboration("p1", "q1");
    assert.equal(byTarget(beforeMission, "bg").anchorDeleted, false, "layer с свободным targetId не удалён");
    assert.equal(byTarget(beforeMission, "scenes.workshop.title").anchorDeleted, false, "field с namespace targetId не удалён");
    assert.equal(byTarget(beforeMission, "forward.layer-1").anchorDeleted, false, "слой живого блока не удалён");
    assert.equal(byTarget(beforeMission, null).anchorDeleted, false, "пин на доске не удалён");
    assert.equal(byTarget(beforeMission, "forward").anchorDeleted, false, "без документа миссии сцена резолвится по блокам черновика");

    // --- authored mission document becomes authoritative for the scene id space ---
    const saved = await store.saveMission("p1", "q1", {
      baseRevision: 0,
      mission: missionDoc(),
      idempotencyKey: "r33-mission",
      actorUserId: "owner"
    });
    assert.equal(saved.kind, "saved");

    await anchorThread(store, "r33-scene-mission", { kind: "scene", targetId: "depot", position: null });
    await anchorThread(store, "r33-scene-ending", { kind: "scene", targetId: "found", position: null });
    await anchorThread(store, "r33-scene-missing", { kind: "scene", targetId: "vanished", position: null });

    const withMission = await store.getCollaboration("p1", "q1");
    // The block-id collision must NOT revive a scene anchor: "forward" is a live
    // draft block but not a scene of the authored mission document.
    assert.equal(byTarget(withMission, "forward").anchorDeleted, true, "совпавший id блока не оживляет чужой scene-якорь");
    assert.equal(byTarget(withMission, "depot").anchorDeleted, false, "сцена документа жива");
    assert.equal(byTarget(withMission, "found").anchorDeleted, false, "концовка документа жива");
    assert.equal(byTarget(withMission, "vanished").anchorDeleted, true, "отсутствующая в документе сцена удалена");
    // layer/field stay alive while their own scope lives, regardless of the scene set.
    assert.equal(byTarget(withMission, "bg").anchorDeleted, false, "layer не считается по множеству блоков");
    assert.equal(byTarget(withMission, "scenes.workshop.title").anchorDeleted, false, "field не считается по множеству блоков");
    assert.equal(byTarget(withMission, "forward.layer-1").anchorDeleted, false, "слой живого блока не удалён и после появления миссии");
    assert.equal(byTarget(withMission, null).anchorDeleted, false, "пин на доске не удалён");

    // --- enclosing scope genuinely gone: layer/field follow the block lifecycle ---
    const draft = await store.getDraft("p1", "q1");
    const removal = await store.applyDraftChanges("p1", "q1", {
      baseRevision: draft.draftRevision,
      changes: [{ kind: "block.remove", blockId: "forward" }]
    });
    assert.equal(removal.kind, "updated");

    const afterRemoval = await store.getCollaboration("p1", "q1");
    assert.equal(byTarget(afterRemoval, "forward.layer-1").anchorDeleted, true, "слой удалённого блока помечен удалённым");
    assert.equal(byTarget(afterRemoval, "bg").anchorDeleted, false, "неразрешимый targetId остаётся живым");
    assert.equal(byTarget(afterRemoval, "forward").anchorDeleted, true, "сцена по-прежнему отсутствует в документе");
  } finally {
    await dispose(dir, store);
  }
});

test("R-34 createMissionSession: idempotency is per participant, a foreign actor never gets a replay", async () => {
  const { dir, store } = await makeStore();
  try {
    const saved = await store.saveMission("p1", "q1", {
      baseRevision: 0,
      mission: missionDoc(),
      idempotencyKey: "r34-mission",
      actorUserId: "owner"
    });
    assert.equal(saved.kind, "saved");

    const requestKey = "shared-idempotency-key";
    const opened = await store.createMissionSession("p1", "q1", {
      sessionId: "session-a",
      idempotencyKey: requestKey,
      actorUserId: "author-1",
      initialWorld: emptyWorld()
    });
    assert.equal(opened.kind, "created");
    assert.equal(opened.session.actorUserId, "author-1");
    assert.equal(opened.session.turn, 0);

    // Legitimate repeat by the SAME participant: idempotent replay, byte-identical.
    const replay = await store.createMissionSession("p1", "q1", {
      sessionId: "session-a",
      idempotencyKey: requestKey,
      actorUserId: "author-1",
      initialWorld: emptyWorld()
    });
    assert.equal(replay.kind, "replay");
    assert.deepEqual(replay.session, opened.session, "повтор того же участника идемпотентен");
    assert.equal(replay.session.sessionId, "session-a");
    assert.equal(replay.session.turn, 0);

    // Same (sessionId, idempotencyKey) from ANOTHER participant: refused, and no
    // session of author-1 is handed over.
    const foreign = await store.createMissionSession("p1", "q1", {
      sessionId: "session-a",
      idempotencyKey: requestKey,
      actorUserId: "author-2",
      initialWorld: emptyWorld()
    });
    assert.deepEqual(foreign, { kind: "idempotency_key_reused" }, "чужой участник не получает replay чужой сессии");

    // A foreign participant reusing only the key (own sessionId) is refused too.
    const foreignKeyOnly = await store.createMissionSession("p1", "q1", {
      sessionId: "session-b",
      idempotencyKey: requestKey,
      actorUserId: "author-2",
      initialWorld: emptyWorld()
    });
    assert.deepEqual(foreignKeyOnly, { kind: "idempotency_key_reused" });

    // A foreign participant reusing only sessionId (own key) hits the binding guard.
    const foreignSessionOnly = await store.createMissionSession("p1", "q1", {
      sessionId: "session-a",
      idempotencyKey: "author-2-key",
      actorUserId: "author-2",
      initialWorld: emptyWorld()
    });
    assert.deepEqual(foreignSessionOnly, { kind: "session_binding_conflict" });

    // The original session belongs to its opener and is untouched.
    const stored = await store.getMissionSession("session-a");
    assert.equal(stored.actorUserId, "author-1");
    assert.equal(stored.turn, 0);

    // A fresh (sessionId, key) opens normally for the other participant.
    const ownSession = await store.createMissionSession("p1", "q1", {
      sessionId: "session-c",
      idempotencyKey: "author-2-own-key",
      actorUserId: "author-2",
      initialWorld: emptyWorld()
    });
    assert.equal(ownSession.kind, "created");
    assert.equal(ownSession.session.actorUserId, "author-2");
  } finally {
    await dispose(dir, store);
  }
});
