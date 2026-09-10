import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteControlStore } from "../../../packages/control/dist/index.js";
import { createControlHttpServer } from "../dist/control-server.js";

async function request(base, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.json === undefined ? undefined : JSON.stringify(options.json)
  });
  return { status: response.status, body: await response.json() };
}

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

test("M02 Control HTTP mission: document, sessions and turns over the wire", async () => {
  const dir = await mkdtemp(join(tmpdir(), "living-history-mission-http-"));
  const store = new SQLiteControlStore({ path: join(dir, "control.sqlite") });
  const control = createControlHttpServer({ store, boardStore: store, missionStore: store });
  try {
    assert.equal((await store.createProject({ projectId: "project", title: "Проект" })).kind, "created");
    assert.equal((await store.createQuest({
      projectId: "project",
      questId: "quest",
      title: "Квест",
      entryLocationId: "workshop",
      initialBlocks: [{
        schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: {}
      }]
    })).kind, "created");
    const address = await control.listen();
    const base = `http://${address.host}:${address.port}`;
    const quest = "/control/v1/projects/project/quests/quest/mission";

    const missing = await request(base, quest);
    assert.equal(missing.status, 404);

    const saved = await request(base, quest, {
      method: "POST", headers: { "idempotency-key": "mission-http-1" },
      json: { baseRevision: 0, mission: missionDoc() }
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.mission.contentRevision, 1);

    const fetched = await request(base, quest);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.mission.contentHash, saved.body.mission.contentHash);

    const created = await request(base, `${quest}/sessions`, {
      method: "POST", headers: { "idempotency-key": "sess-http-1" },
      json: { sessionId: "http-session", initialWorld: emptyWorld() }
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.session.currentSceneId, "depot");

    const turn = await request(base, `${quest}/sessions/http-session/turns`, {
      method: "POST", headers: { "idempotency-key": "turn-http-1" },
      json: { baseTurn: 0, choiceId: "go-tracks" }
    });
    assert.equal(turn.status, 200);
    assert.equal(turn.body.session.currentSceneId, "tracks");
    assert.deepEqual(turn.body.target, { kind: "scene", sceneId: "tracks" });

    const stale = await request(base, `${quest}/sessions/http-session/turns`, {
      method: "POST", headers: { "idempotency-key": "turn-http-2" },
      json: { baseTurn: 0, choiceId: "go-watchman" }
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "MISSION_TURN_CONFLICT");

    const got = await request(base, `${quest}/sessions/http-session`);
    assert.equal(got.status, 200);
    assert.equal(got.body.session.turn, 1);
  } finally {
    await control.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
