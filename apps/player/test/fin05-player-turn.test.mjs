// FIN-05 (Player): ход истории уходит на сервер, а позиция назначается ОТВЕТОМ
// сервера, а не локальной догадкой. Здесь проверяется реальный dev-server
// Player (HTTP), реальный серверный модуль хода поверх control-стора и
// деградация модели, когда сервер хода недоступен.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQLiteControlStore } from "@living-history/control";
import { createPlayerTurnService } from "../../server/dist/player-turn.js";
import { createPlayerDevServer } from "../dist/src/dev-server.js";
import {
  createStoryScreens,
  storyScreensTurnApplied,
  storyScreensTurnFailureMessage,
  storyScreensTurnRejected,
  storyScreensView
} from "../dist/src/story-screens.js";

const PAINT = "paint";

const metadata = Object.freeze({
  templateId: "minimal-paint",
  playtestId: "playtest-turn",
  questTitle: "Тестовый квест",
  locationTitle: "Мастерская",
  sceneText: "Текст.",
  resourceId: PAINT,
  resourceTitle: "Краска",
  resourceUnit: "portion",
  actionId: "paint",
  actionTitle: "Рисовать"
});

function mission() {
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
            },
            {
              id: "gated",
              label: "Нужно пять порций",
              targetSceneId: "painted",
              endingId: null,
              conditions: [{ schemaVersion: "1.0", type: "resource.atLeast", resourceId: PAINT, value: 5 }],
              effects: []
            }
          ]
        },
        {
          id: "painted",
          title: "Готово",
          text: "",
          dialogue: [{ id: "p1", speakerId: null, text: "Краска легла." }],
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

async function makeFixture(t, turnOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "lh-player-turn-http-"));
  const path = join(directory, "control.sqlite");
  const store = new SQLiteControlStore({ path });
  await store.createProject({ projectId: "project", title: "Проект" });
  await store.createQuest({
    projectId: "project",
    questId: "quest",
    title: "Мастерская",
    entryLocationId: "workshop",
    initialBlocks: [
      { schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "", data: {} }
    ]
  });
  const saved = await store.saveMission("project", "quest", {
    baseRevision: 0,
    mission: mission(),
    idempotencyKey: "seed-mission",
    actorUserId: "owner"
  });
  assert.equal(saved.kind, "saved", JSON.stringify(saved));

  const service = turnOptions.service ?? createPlayerTurnService(store, {
    projectId: "project",
    questId: "quest",
    contentRevision: 1,
    actorUserId: "player",
    initialWorld: initialWorld()
  });
  const withTurn = turnOptions.withoutRoute === true ? {} : { turn: { service } };

  const player = createPlayerDevServer({
    runtimeOrigin: "http://127.0.0.1:9",
    metadata,
    story: { mission: mission() },
    ...withTurn
  });
  const { port } = await player.listen();
  t.after(async () => {
    await player.close();
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  });
  return { baseUrl: `http://127.0.0.1:${port}`, service, store };
}

async function postTurn(baseUrl, body) {
  const response = await fetch(`${baseUrl}/player-turn.json`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: response.status, body: parsed, text };
}

test("FIN-05 ход (Player): ход применяется сервером и виден в состоянии", async (t) => {
  const fixture = await makeFixture(t);

  const before = await fetch(`${fixture.baseUrl}/player-turn.json?sessionId=story-http-1`);
  assert.equal(before.status, 404, "до первого хода сессии хода нет");
  assert.equal((await before.json()).error.code, "TURN_SESSION_NOT_FOUND");

  const applied = await postTurn(fixture.baseUrl, {
    sessionId: "story-http-1",
    choiceId: "paint-now",
    baseTurn: 0,
    idempotencyKey: "http-turn-1"
  });
  assert.equal(applied.status, 200, JSON.stringify(applied));
  assert.equal(applied.body.replay, false);
  assert.equal(applied.body.state.position.sceneId, "painted", "переход по ответу сервера");
  assert.equal(applied.body.state.position.turn, 1);
  assert.equal(applied.body.state.contentRevision, 1, "сессия прибита к авторской ревизии");
  assert.deepEqual(
    applied.body.state.options.map((option) => [option.choiceId, option.status]),
    [["finish", "available"]],
    "на новой сцене виден только её выбор"
  );
  assert.equal(applied.body.state.world.resources.find((resource) => resource.id === PAINT).value, 0);

  const state = await fetch(`${fixture.baseUrl}/player-turn.json?sessionId=story-http-1`);
  assert.equal(state.status, 200);
  const viewed = await state.json();
  assert.equal(viewed.state.position.sceneId, "painted", "новая позиция видна в состоянии");
  assert.equal(viewed.state.position.turn, 1);
  assert.equal(viewed.state.world.resources.find((resource) => resource.id === PAINT).value, 0);

  // Повтор того же ключа — тот же ход.
  const replay = await postTurn(fixture.baseUrl, {
    sessionId: "story-http-1",
    choiceId: "paint-now",
    baseTurn: 0,
    idempotencyKey: "http-turn-1"
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replay, true);
  assert.equal(replay.body.state.position.turn, 1);

  // Финал достижим и закрывает ходы.
  const ending = await postTurn(fixture.baseUrl, {
    sessionId: "story-http-1",
    choiceId: "finish",
    baseTurn: 1,
    idempotencyKey: "http-turn-2"
  });
  assert.equal(ending.status, 200, JSON.stringify(ending));
  assert.equal(ending.body.state.position.endingId, "win");
  assert.equal(ending.body.state.position.terminal, true);
  assert.deepEqual(ending.body.state.options, []);

  const afterEnd = await postTurn(fixture.baseUrl, {
    sessionId: "story-http-1",
    choiceId: "finish",
    baseTurn: 2,
    idempotencyKey: "http-turn-3"
  });
  assert.equal(afterEnd.status, 422);
  assert.equal(afterEnd.body.error.code, "TURN_MISSION_ENDED");
  const ended = await (await fetch(`${fixture.baseUrl}/player-turn.json?sessionId=story-http-1`)).json();
  assert.equal(ended.state.position.turn, 2);
  assert.equal(ended.state.position.endingId, "win");
});

test("FIN-05 ход (Player): недоступный выбор отклонён без изменения позиции", async (t) => {
  const fixture = await makeFixture(t);

  const blocked = await postTurn(fixture.baseUrl, {
    sessionId: "story-http-2",
    choiceId: "gated",
    baseTurn: 0,
    idempotencyKey: "http-blocked"
  });
  assert.equal(blocked.status, 422, JSON.stringify(blocked));
  assert.equal(blocked.body.error.code, "TURN_CHOICE_BLOCKED");
  const afterBlocked = await (await fetch(`${fixture.baseUrl}/player-turn.json?sessionId=story-http-2`)).json();
  assert.equal(afterBlocked.state.position.sceneId, "start", "отказ не сдвигает позицию");
  assert.equal(afterBlocked.state.position.turn, 0, "отказ не тратит ход");
  assert.equal(afterBlocked.state.world.resources.find((resource) => resource.id === PAINT).value, 1);

  const foreign = await postTurn(fixture.baseUrl, {
    sessionId: "story-http-2",
    choiceId: "finish",
    baseTurn: 0,
    idempotencyKey: "http-foreign"
  });
  assert.equal(foreign.status, 422);
  assert.equal(foreign.body.error.code, "TURN_CHOICE_NOT_IN_SCENE");

  const stale = await postTurn(fixture.baseUrl, {
    sessionId: "story-http-2",
    choiceId: "paint-now",
    baseTurn: 3,
    idempotencyKey: "http-stale"
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "TURN_CONFLICT");

  const malformed = await fetch(`${fixture.baseUrl}/player-turn.json`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "story-http-2", choiceId: "paint-now", baseTurn: "0", idempotencyKey: "x" })
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "INVALID_TURN_REQUEST");

  const wrongMethod = await fetch(`${fixture.baseUrl}/player-turn.json`, { method: "PUT", body: "{}" });
  assert.equal(wrongMethod.status, 405);

  const stillThere = await (await fetch(`${fixture.baseUrl}/player-turn.json?sessionId=story-http-2`)).json();
  assert.equal(stillThere.state.position.turn, 0);
  assert.equal(stillThere.state.position.sceneId, "start");
});

test("FIN-05 ход (Player): модель переходит по ответу сервера и не двигается сама", () => {
  const mission = {
    entrySceneId: "start",
    scenes: [
      { id: "start", title: "Начало", text: "", dialogue: [{ id: "l1", speakerId: null, text: "С чего начать?" }], choices: [] },
      { id: "painted", title: "Готово", text: "", dialogue: [], choices: [] }
    ],
    endings: [{ id: "win", title: "Победа", text: "" }],
    intros: [],
    sceneScreens: {},
    endingScreens: {}
  };
  const current = createStoryScreens(mission);
  assert.equal(current.phase, "scene", "без вступлений история начинается сразу в сцене");
  const sceneState = Object.freeze({ ...current, revealed: 1, turns: 0 });

  const applied = storyScreensTurnApplied(sceneState, { turn: 1, sceneId: "painted", endingId: null });
  assert.equal(applied.ok, true);
  assert.equal(applied.state.phase, "scene");
  assert.equal(applied.state.sceneId, "painted");
  assert.equal(applied.state.endingId, null);
  assert.equal(applied.state.revealed, 0, "диалог целевой сцены раскрывается заново");
  assert.equal(applied.state.turns, 1, "ревизия хода приходит с сервера");
  assert.equal(applied.state.identity, sceneState.identity, "позиция остаётся привязана к тому же контенту");
  assert.match(applied.message, /сервером/);

  const ending = storyScreensTurnApplied(sceneState, { turn: 4, sceneId: "painted", endingId: "win" });
  assert.equal(ending.state.phase, "ending");
  assert.equal(ending.state.endingId, "win");
  assert.equal(ending.state.turns, 4);

  // Отказ: то же состояние, никакого локального «перехода по догадке».
  const refused = storyScreensTurnRejected(sceneState, { network: false, status: 422, code: "TURN_CHOICE_BLOCKED" });
  assert.equal(refused.ok, false);
  assert.equal(refused.state, sceneState, "состояние не заменяется при отказе");
  assert.match(refused.message, /недоступен/);

  const offline = storyScreensTurnRejected(sceneState, { network: true, status: 0, code: null });
  assert.equal(offline.state, sceneState);
  assert.equal(offline.message, "Сервер хода недоступен: позиция не изменена.");
  assert.equal(
    storyScreensTurnFailureMessage({ network: false, status: 503, code: null }),
    "Сервер хода недоступен: позиция не изменена."
  );
  assert.match(storyScreensTurnFailureMessage({ network: false, status: 409, code: "TURN_CONFLICT" }), /устарел/);
  assert.match(storyScreensTurnFailureMessage({ network: false, status: 422, code: "TURN_MISSION_ENDED" }), /завершена/);
  assert.match(storyScreensTurnFailureMessage({ network: false, status: 500, code: null }), /Позиция не изменена/);

  // Рендер не падает на серверной позиции.
  const view = storyScreensView(applied.state, mission);
  assert.equal(view.title, "Готово");
  assert.equal(view.turn, 1);
});

test("FIN-05 ход (Player): app.js отправляет ход на сервер и не подменяет ответ", async (t) => {
  const fixture = await makeFixture(t);
  const code = await (await fetch(`${fixture.baseUrl}/player-assets/app.js`)).text();
  assert.match(code, /player-turn\.json/, "ход уходит на серверный маршрут");
  assert.match(code, /commitStoryTurn/);
  assert.match(code, /storyScreensTurnApplied/, "позиция берётся из ответа сервера");
  assert.match(code, /storyScreensTurnRejected/, "отказ сервера не подменяется успехом");
  assert.match(code, /network: true/, "недоступность сервера распознаётся отдельно");
  assert.doesNotMatch(code, /pendingTurn/, "локальная догадка о переходе удалена");
  assert.doesNotMatch(code, /result\.turnRequest\) state\.story\.screens/, "ход не применяется локально");

  const model = await (await fetch(`${fixture.baseUrl}/player-assets/story-screens.js`)).text();
  assert.match(model, /storyScreensTurnApplied/);
  assert.match(model, /storyScreensTurnRejected/);
  assert.match(model, /Сервер хода недоступен/);
});

test("FIN-05 ход (Player): недоступный сервер хода даёт деградацию, а не переход", async (t) => {
  // Маршрута хода нет вовсе (сервер хода не сконфигурирован).
  const withoutRoute = await makeFixture(t, { withoutRoute: true });
  const missing = await postTurn(withoutRoute.baseUrl, {
    sessionId: "story-http-3",
    choiceId: "paint-now",
    baseTurn: 0,
    idempotencyKey: "http-no-route"
  });
  assert.equal(missing.status, 404, "без серверного хода маршрут не поднимается");
  assert.equal(
    storyScreensTurnRejected({ turns: 0 }, { network: false, status: missing.status, code: null }).message,
    "Сессия хода не найдена на сервере: позиция не изменена."
  );

  // Сервер хода упал: Player обязан деградировать понятным сообщением.
  const broken = await makeFixture(t, {
    service: {
      state: async () => { throw new Error("store down"); },
      applyTurn: async () => { throw new Error("store down"); },
      openSession: async () => { throw new Error("store down"); }
    }
  });
  const failed = await postTurn(broken.baseUrl, {
    sessionId: "story-http-4",
    choiceId: "paint-now",
    baseTurn: 0,
    idempotencyKey: "http-broken"
  });
  assert.equal(failed.status, 500);
  const message = storyScreensTurnFailureMessage({ network: false, status: failed.status, code: null });
  assert.match(message, /Позиция не изменена/);
});

// --- Реальная проводка: dev:player из frozen playtest ---

function frozenMission() {
  const doc = mission();
  doc.story.scenes[0].choices[0].effects = [
    { schemaVersion: "1.0", type: "resource.change", sourceId: "start", resourceId: "blue_paint", delta: -1 }
  ];
  doc.story.scenes[0].choices[1].conditions = [
    { schemaVersion: "1.0", type: "resource.atLeast", resourceId: "blue_paint", value: 5 }
  ];
  return doc;
}

test("FIN-05 ход (Player): реальный dev:player применяет ход поверх frozen playtest", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lh-player-turn-process-"));
  const databasePath = join(directory, "living-history.sqlite");
  const store = new SQLiteControlStore({ path: databasePath });
  let child = null;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    try { store.close(); } catch { /* already closed before spawn */ }
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  });

  assert.equal((await store.createProject({ projectId: "project", title: "Проект" })).kind, "created");
  assert.equal((await store.createQuest({
    projectId: "project",
    questId: "quest",
    title: "Мастерская",
    entryLocationId: "workshop",
    initialBlocks: [locationBlock()]
  })).kind, "created");
  assert.equal((await store.applyDraftChanges("project", "quest", {
    baseRevision: 0,
    changes: [{ kind: "block.add", block: resourceBlock() }, { kind: "block.add", block: paintActionBlock(2) }]
  })).kind, "updated");
  const validated = await store.validateDraft("project", "quest", 1);
  assert.equal(validated.kind, "validated");
  assert.equal((await store.saveMission("project", "quest", {
    baseRevision: 0,
    mission: frozenMission(),
    idempotencyKey: "fin05-turn-mission",
    actorUserId: "author"
  })).kind, "saved");
  const frozen = await store.createPlaytest({
    projectId: "project",
    questId: "quest",
    draftRevision: 1,
    validationId: validated.validation.validationId
  });
  assert.equal(frozen.kind, "created");
  const playtestId = frozen.playtest.playtestId;
  store.close();

  child = spawn(process.execPath, [fileURLToPath(new URL("../dist/src/main.js", import.meta.url))], {
    env: { ...process.env, LH_DATABASE_PATH: databasePath, LH_PLAYTEST_ID: playtestId, LH_PLAYER_PORT: "0", LH_RUNTIME_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const baseUrl = await waitForPlayerUrl(child, () => stderr);

  const applied = await postTurn(baseUrl, {
    sessionId: "story-process-1",
    choiceId: "paint-now",
    baseTurn: 0,
    idempotencyKey: "process-turn-1"
  });
  assert.equal(applied.status, 200, `${JSON.stringify(applied)} stderr=${stderr}`);
  assert.equal(applied.body.state.position.sceneId, "painted");
  assert.equal(applied.body.state.position.turn, 1);
  assert.equal(applied.body.state.contentRevision, 1);
  const paint = applied.body.state.world.resources.find((resource) => resource.id === "blue_paint");
  assert.equal(paint.value, 1, "эффект хода списан с мира frozen playtest (2 → 1)");

  const blocked = await postTurn(baseUrl, {
    sessionId: "story-process-2",
    choiceId: "gated",
    baseTurn: 0,
    idempotencyKey: "process-turn-2"
  });
  assert.equal(blocked.status, 422, JSON.stringify(blocked));
  assert.equal(blocked.body.error.code, "TURN_CHOICE_BLOCKED");
  const unchanged = await (await fetch(`${baseUrl}/player-turn.json?sessionId=story-process-2`)).json();
  assert.equal(unchanged.state.position.sceneId, "start");
  assert.equal(unchanged.state.world.resources.find((resource) => resource.id === "blue_paint").value, 2);
});

async function waitForPlayerUrl(child, getStderr) {
  child.stdout.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`Player did not start. stderr: ${getStderr()}`)), 15_000);
    const onData = (chunk) => {
      stdout += String(chunk);
      const match = /Living History Player: (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
      if (!match) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      resolve(match[1]);
    };
    const onExit = (code) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      reject(new Error(`Player exited before listening (${code}). stderr: ${getStderr()}`));
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

function locationBlock() {
  return Object.freeze({ schemaVersion: "1.0", id: "workshop", kind: "core.location", title: "Мастерская", description: "Описание.", data: Object.freeze({}) });
}

function resourceBlock() {
  return Object.freeze({ schemaVersion: "1.0", id: "blue_paint", kind: "core.resource", title: "Краска", description: "", data: Object.freeze({ unit: "portion", initialValue: 2, min: 0, max: 20 }) });
}

function paintActionBlock(cost) {
  return Object.freeze({
    schemaVersion: "1.0", id: "paint", kind: "core.action", title: "Рисовать", description: "Потратить краску.",
    data: Object.freeze({ actionType: "core.paint", resourceId: "blue_paint", resourceUnitsPerUnit: cost, durationSecondsPerUnit: 300, allowPartial: true })
  });
}
