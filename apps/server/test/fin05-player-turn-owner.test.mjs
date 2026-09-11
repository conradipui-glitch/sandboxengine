// FIN-05 (owner): сессия хода принадлежит участнику, а не «кому угодно в том
// же квесте». Чужой игрок, знающий только sessionId, не должен ни читать, ни
// вести чужую игру. Тест фиксирует это поведением: сервис того же проекта и
// миссии, но с другим actorUserId, обязан получить пустое состояние (404 у
// HTTP-поверхности) и session_not_found на попытке хода, а легитимный владелец
// продолжает играть.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteControlStore } from "../../../packages/control/dist/index.js";
import { createPlayerTurnService } from "../dist/player-turn.js";

const PAINT = "paint";

function missionDoc() {
  return {
    schemaVersion: "1.0",
    projectId: "project",
    questId: "quest",
    contentRevision: 0,
    contentHash: "",
    listing: {
      title: "Ход истории",
      slug: "player-turn",
      summary: "",
      coverAssetId: null,
      period: "",
      place: "",
      playerRole: "",
      estimatedMinutes: 15,
      supportedModes: ["choice"]
    },
    story: {
      entrySceneId: "start",
      scenes: [
        {
          id: "start",
          title: "Начало",
          text: "Мастерская.",
          dialogue: [{ id: "l1", speakerId: null, text: "С чего начать?" }],
          choices: [
            {
              id: "paint-now",
              label: "Потратить краску",
              targetSceneId: "painted",
              endingId: null,
              conditions: [],
              effects: [{ schemaVersion: "1.0", type: "resource.change", sourceId: "start", resourceId: PAINT, delta: -1 }]
            }
          ]
        },
        {
          id: "painted",
          title: "Готово",
          text: "",
          dialogue: [],
          choices: [
            {
              id: "finish",
              label: "Завершить",
              targetSceneId: null,
              endingId: "win",
              conditions: [],
              effects: []
            }
          ]
        }
      ],
      endings: [{ id: "win", title: "Победа", text: "Получилось." }]
    },
    screens: { intros: [], scenes: {}, endings: {} },
    defaults: { background: null, theme: "", animationPreset: "fade" }
  };
}

function initialWorld() {
  return {
    schemaVersion: "1.0",
    revision: 0,
    clock: { elapsedSeconds: 0 },
    locations: [],
    entities: [],
    resources: [{ id: PAINT, unit: "portion", value: 1, min: 0, max: 5 }],
    items: [],
    terminal: null
  };
}

async function makeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "lh-player-turn-owner-"));
  const path = join(directory, "control.sqlite");
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
    idempotencyKey: "seed-mission",
    actorUserId: "owner"
  });
  assert.equal(saved.kind, "saved", JSON.stringify(saved));
  const bind = (actorUserId) => createPlayerTurnService(store, {
    projectId: "project",
    questId: "quest",
    contentRevision: 1,
    actorUserId,
    initialWorld: initialWorld()
  });
  return {
    store,
    owner: bind("player-a"),
    foreign: bind("player-b"),
    async cleanup() {
      store.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
    }
  };
}

test("FIN-05 owner: чужой игрок того же квеста не читает и не ведёт чужую сессию", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);

  const sessionId = "owned-session-1";
  const opened = await fixture.owner.openSession({ sessionId, idempotencyKey: "open-owned" });
  assert.equal(opened.kind, "created", JSON.stringify(opened));
  assert.equal(opened.state.position.turn, 0);

  // Чтение чужой сессии: сервис чужого участника не должен её видеть.
  const peek = await fixture.foreign.state(sessionId);
  assert.equal(peek, null, "чужая сессия не читается по одному sessionId");

  // Ведение чужой сессии: ход чужого участника отвергается, позиция не двигается.
  const hijack = await fixture.foreign.applyTurn({
    sessionId,
    choiceId: "paint-now",
    baseTurn: 0,
    idempotencyKey: "foreign-turn-1"
  });
  assert.equal(hijack.kind, "session_not_found", JSON.stringify(hijack));

  const afterHijack = await fixture.owner.state(sessionId);
  assert.notEqual(afterHijack, null);
  assert.equal(afterHijack.position.turn, 0, "чужой ход не потратил ход владельца");
  assert.equal(afterHijack.position.sceneId, "start", "чужой ход не сдвинул позицию владельца");
  assert.equal(afterHijack.world.resources.find((resource) => resource.id === PAINT).value, 1, "чужой ход не списал ресурс");

  // Легитимный владелец продолжает играть тем же sessionId.
  const owned = await fixture.owner.applyTurn({
    sessionId,
    choiceId: "paint-now",
    baseTurn: 0,
    idempotencyKey: "owner-turn-1"
  });
  assert.equal(owned.kind, "applied", JSON.stringify(owned));
  assert.equal(owned.state.position.sceneId, "painted");
  assert.equal(owned.state.position.turn, 1);

  // Даже зная применённый ход, чужой не повторяет его как свой.
  const foreignReplay = await fixture.foreign.applyTurn({
    sessionId,
    choiceId: "paint-now",
    baseTurn: 0,
    idempotencyKey: "owner-turn-1"
  });
  assert.equal(foreignReplay.kind, "session_not_found", JSON.stringify(foreignReplay));
});

test("FIN-05 owner: чужой участник не может закрепить существующую сессию за собой", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);

  const sessionId = "owned-session-2";
  const opened = await fixture.owner.openSession({ sessionId, idempotencyKey: "open-owned-2" });
  assert.equal(opened.kind, "created");

  const claim = await fixture.foreign.openSession({ sessionId, idempotencyKey: "open-foreign-2" });
  assert.notEqual(claim.kind, "created", JSON.stringify(claim));
  assert.notEqual(claim.kind, "replay", JSON.stringify(claim));
});
