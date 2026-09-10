import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteControlStore } from "../dist/index.js";

function missionDoc() {
  return {
    schemaVersion: "1.0",
    projectId: "project",
    questId: "quest",
    contentRevision: 0,
    contentHash: "",
    listing: {
      title: "Пропавший груз на станции",
      slug: "propavshiy-gruz",
      summary: "Найти груз до рассвета.",
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
        {
          id: "depot", title: "Депо", text: "Ночь.", dialogue: [],
          choices: [
            { id: "go-tracks", label: "На пути", targetSceneId: "tracks", endingId: null, conditions: [], effects: [] },
            { id: "go-watchman", label: "В сторожку", targetSceneId: "watchman", endingId: null, conditions: [], effects: [] }
          ]
        },
        {
          id: "tracks", title: "Пути", text: "Тупик.", dialogue: [],
          choices: [{ id: "open", label: "Открыть", targetSceneId: null, endingId: "found", conditions: [], effects: [] }]
        },
        {
          id: "watchman", title: "Сторожка", text: "Молчание.", dialogue: [],
          choices: [{ id: "leave", label: "Уйти", targetSceneId: null, endingId: "lost", conditions: [], effects: [] }]
        }
      ],
      endings: [
        { id: "found", title: "Найден", text: "Ящики." },
        { id: "lost", title: "Потерян", text: "Рассвело." }
      ]
    },
    screens: { intros: [], scenes: {}, endings: {} },
    defaults: { background: null, theme: "station-night", animationPreset: "calm" }
  };
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

async function makeStore(path) {
  const store = new SQLiteControlStore({ path });
  await store.createProject({ projectId: "project", title: "Проект" });
  await store.createQuest({
    projectId: "project",
    questId: "quest",
    title: "Квест",
    entryLocationId: "workshop",
    initialBlocks: [
      { schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: {} }
    ]
  });
  const saved = await store.saveMission("project", "quest", {
    baseRevision: 0,
    mission: missionDoc(),
    idempotencyKey: "mission-seed",
    actorUserId: "owner"
  });
  assert.equal(saved.kind, "saved");
  return store;
}

test("M02 mission sessions: fork A/B diverge, replay and conflicts behave", async () => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-mturn-"));
  const path = join(dir, "control.sqlite");
  const store = await makeStore(path);
  try {
    const created = await store.createMissionSession("project", "quest", {
      sessionId: "session-a",
      idempotencyKey: "sess-a",
      actorUserId: "owner",
      initialWorld: emptyWorld()
    });
    assert.equal(created.kind, "created");
    assert.equal(created.session.currentSceneId, "depot");
    assert.equal(created.session.turn, 0);
    assert.equal(created.session.contentRevision, 1);

    const turnA = await store.applyMissionTurn("session-a", {
      baseTurn: 0,
      choiceId: "go-tracks",
      idempotencyKey: "turn-a1",
      actorUserId: "owner"
    });
    assert.equal(turnA.kind, "applied");
    assert.equal(turnA.session.currentSceneId, "tracks");
    assert.equal(turnA.session.turn, 1);

    const replay = await store.applyMissionTurn("session-a", {
      baseTurn: 0,
      choiceId: "go-tracks",
      idempotencyKey: "turn-a1",
      actorUserId: "owner"
    });
    assert.equal(replay.kind, "replay");
    assert.equal(replay.session.turn, 1);

    const stale = await store.applyMissionTurn("session-a", {
      baseTurn: 0,
      choiceId: "open",
      idempotencyKey: "turn-a2",
      actorUserId: "owner"
    });
    assert.equal(stale.kind, "turn_conflict");
    assert.equal(stale.currentTurn, 1);

    const finish = await store.applyMissionTurn("session-a", {
      baseTurn: 1,
      choiceId: "open",
      idempotencyKey: "turn-a3",
      actorUserId: "owner"
    });
    assert.equal(finish.kind, "applied");
    assert.equal(finish.target.kind, "ending");

    const ended = await store.applyMissionTurn("session-a", {
      baseTurn: 2,
      choiceId: "open",
      idempotencyKey: "turn-a4",
      actorUserId: "owner"
    });
    assert.equal(ended.kind, "mission_ended");

    const createdB = await store.createMissionSession("project", "quest", {
      sessionId: "session-b",
      idempotencyKey: "sess-b",
      actorUserId: "owner",
      initialWorld: emptyWorld()
    });
    assert.equal(createdB.kind, "created");
    const turnB = await store.applyMissionTurn("session-b", {
      baseTurn: 0,
      choiceId: "go-watchman",
      idempotencyKey: "turn-b1",
      actorUserId: "owner"
    });
    assert.equal(turnB.kind, "applied");
    assert.equal(turnB.session.currentSceneId, "watchman");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("M02 mission sessions: resume after restart keeps the exact pinned release", async () => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-mresume-"));
  const path = join(dir, "control.sqlite");
  const store = await makeStore(path);
  const created = await store.createMissionSession("project", "quest", {
    sessionId: "session-r",
    idempotencyKey: "sess-r",
    actorUserId: "owner",
    initialWorld: emptyWorld()
  });
  assert.equal(created.kind, "created");
  const pinnedHash = created.session.contentHash;
  const turn = await store.applyMissionTurn("session-r", {
    baseTurn: 0,
    choiceId: "go-tracks",
    idempotencyKey: "turn-r1",
    actorUserId: "owner"
  });
  assert.equal(turn.kind, "applied");
  store.close();

  const reopened = new SQLiteControlStore({ path });
  try {
    const resumed = await reopened.getMissionSession("session-r");
    assert.equal(resumed.currentSceneId, "tracks");
    assert.equal(resumed.turn, 1);
    assert.equal(resumed.contentHash, pinnedHash);
    const continued = await reopened.applyMissionTurn("session-r", {
      baseTurn: 1,
      choiceId: "open",
      idempotencyKey: "turn-r2",
      actorUserId: "owner"
    });
    assert.equal(continued.kind, "applied");
    assert.equal(continued.target.kind, "ending");
    const db = new DatabaseSync(path);
    const row = db.prepare("SELECT value FROM control_meta WHERE key = 'schema_version'").get();
    db.close();
    assert.equal(Number(row.value), 4);
  } finally {
    reopened.close();
    await rm(dir, { recursive: true, force: true });
  }
});
