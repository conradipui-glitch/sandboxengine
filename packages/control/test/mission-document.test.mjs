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
            { id: "c1", label: "Пути", targetSceneId: "tracks", endingId: null, conditions: [], effects: [] },
            { id: "c2", label: "Сторожка", targetSceneId: "watchman", endingId: null, conditions: [], effects: [] }
          ]
        },
        {
          id: "tracks", title: "Пути", text: "Тупик.", dialogue: [],
          choices: [{ id: "c3", label: "Вагон", targetSceneId: null, endingId: "found", conditions: [], effects: [] }]
        },
        {
          id: "watchman", title: "Сторожка", text: "Молчание.", dialogue: [],
          choices: [{ id: "c4", label: "Уйти", targetSceneId: null, endingId: "lost", conditions: [], effects: [] }]
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

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), "living-history-mission-"));
  const path = join(dir, "control.sqlite");
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
  return { dir, store };
}

test("M01 SQLite mission: save/get/history/export/import with CAS and idempotency", async () => {
  const { dir, store } = await makeStore();
  try {
    assert.equal(await store.getMission("project", "quest"), null);

    const first = await store.saveMission("project", "quest", {
      baseRevision: 0,
      mission: missionDoc(),
      idempotencyKey: "mission-1",
      actorUserId: "owner"
    });
    assert.equal(first.kind, "saved");
    assert.equal(first.mission.contentRevision, 1);
    assert.equal(first.mission.contentHash.length, 64);

    const replay = await store.saveMission("project", "quest", {
      baseRevision: 0,
      mission: missionDoc(),
      idempotencyKey: "mission-1",
      actorUserId: "owner"
    });
    assert.equal(replay.kind, "replay");
    assert.equal(replay.mission.contentRevision, 1);

    const edited = missionDoc();
    edited.story.scenes[0].text = "Другая ночь.";
    const conflict = await store.saveMission("project", "quest", {
      baseRevision: 0,
      mission: edited,
      idempotencyKey: "mission-2",
      actorUserId: "owner"
    });
    assert.equal(conflict.kind, "revision_conflict");
    assert.equal(conflict.currentRevision, 1);

    const reused = await store.saveMission("project", "quest", {
      baseRevision: 1,
      mission: edited,
      idempotencyKey: "mission-1",
      actorUserId: "owner"
    });
    assert.equal(reused.kind, "idempotency_key_reused");

    const second = await store.saveMission("project", "quest", {
      baseRevision: 1,
      mission: edited,
      idempotencyKey: "mission-3",
      actorUserId: "owner"
    });
    assert.equal(second.kind, "saved");
    assert.equal(second.mission.contentRevision, 2);
    assert.notEqual(second.mission.contentHash, first.mission.contentHash);

    const history = await store.getMissionHistory("project", "quest");
    assert.deepEqual(history.map((entry) => entry.contentRevision), [1, 2]);

    const exported = await store.exportMission("project", "quest");
    assert.equal(exported.contentRevision, 2);

    const bad = missionDoc();
    bad.story.entrySceneId = "void";
    const invalid = await store.saveMission("project", "quest", {
      baseRevision: 2,
      mission: bad,
      idempotencyKey: "mission-4",
      actorUserId: "owner"
    });
    assert.equal(invalid.kind, "invalid_request");
    assert.ok(invalid.errors.includes("mission.entry_missing"));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("M01 SQLite mission: schema migrates to v3", async () => {
  const { dir, store } = await makeStore();
  try {
    const db = new DatabaseSync(join(dir, "control.sqlite"));
    const row = db.prepare("SELECT value FROM control_meta WHERE key = 'schema_version'").get();
    db.close();
    assert.equal(Number(row.value), 3);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
