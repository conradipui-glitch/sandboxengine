// FIN-05 ход (Player): гонка хода истории и валидация ответа.
//
// Характеризующий набор: он исполняет НАСТОЯЩИЙ apps/player/app.js в
// минимальном DOM-шиме (imports браузерных модулей подменены, всё остальное —
// код из файла) и упирается в два дефекта:
//   1) onClick story-choice → commitStoryTurn без блокировки: два клика дают
//      два POST с одним baseTurn, поздний 409 откатывает уже применённый ход
//      и клиент застревает навсегда (baseTurn больше не двигается);
//   2) ответ хода не валидировался, и position.turn уезжал в innerHTML без
//      escapeHtml.
// Тест красный, если убрать in-flight блокировку, ordinal-проверку,
// синхронизацию по GET при TURN_CONFLICT, валидацию позиции или escapeHtml.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import {
  createStoryScreens,
  isSelfActivatingControl,
  storyScreensInput,
  storyScreensKeyInput,
  storyScreensMission,
  storyScreensTurnApplied,
  storyScreensTurnRejected,
  storyScreensView
} from "../dist/src/story-screens.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mission() {
  return storyScreensMission({
    story: {
      entrySceneId: "start",
      scenes: [
        { id: "start", title: "Начало", text: "", dialogue: [], choices: [{ id: "go", label: "Идти", targetSceneId: "painted" }] },
        { id: "painted", title: "Готово", text: "", dialogue: [], choices: [] }
      ],
      endings: [{ id: "win", title: "Победа", text: "" }]
    },
    screens: { intros: [], scenes: {}, endings: {} }
  });
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function positionBody(server) {
  return {
    state: {
      sessionId: "player-story-session",
      position: {
        turn: server.turn,
        sceneId: server.sceneId,
        endingId: server.endingId,
        terminal: server.endingId !== null,
        target: null
      },
      options: [],
      world: null
    }
  };
}

/** Фейковый сервер хода: тот же контракт, что у /player-turn.json. */
function createTurnServer() {
  const server = {
    turn: 0,
    sceneId: "start",
    endingId: null,
    posts: [],
    gets: 0,
    postLatency: () => 5,
    getFails: false,
    conflictFirst: false
  };
  server.handle = async (rawUrl, init) => {
    const target = String(rawUrl);
    const method = String(init?.method ?? "GET").toUpperCase();
    if (target.startsWith("/player-turn.json") && method === "POST") {
      const body = JSON.parse(String(init.body));
      server.posts.push(body);
      await delay(server.postLatency(server.posts.length));
      if (server.reply !== undefined) return server.reply(server, body, server.posts.length);
      if (server.conflictFirst && server.posts.length === 1) {
        return jsonResponse(409, { error: { code: "TURN_CONFLICT", currentTurn: server.turn } });
      }
      if (body.baseTurn !== server.turn) {
        return jsonResponse(409, { error: { code: "TURN_CONFLICT", currentTurn: server.turn } });
      }
      server.turn += 1;
      server.sceneId = "painted";
      return jsonResponse(200, positionBody(server));
    }
    if (target.startsWith("/player-turn.json") && method === "GET") {
      server.gets += 1;
      await delay(2);
      if (server.getFails) return jsonResponse(503, { error: { code: "RUNTIME_UNAVAILABLE" } });
      return jsonResponse(200, positionBody(server));
    }
    if (target.startsWith("/player-meta.json")) return jsonResponse(404, {});
    if (target.startsWith("/player-story.json")) return jsonResponse(404, {});
    throw new Error(`unexpected fetch: ${method} ${target}`);
  };
  return server;
}

/** Загружает реальный app.js в vm-контекст с заглушками браузера. */
async function loadPlayerApp(server) {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const stripped = source.replace(/import[\s\S]*?from\s+"[^"]+";\s*/g, "");
  assert.ok(!/\bimport\b/.test(stripped), "imports браузерных модулей должны быть сняты шимом");

  class HTMLElement {}
  class Element {}
  class HTMLFormElement {}
  class PlayerClientError extends Error {}
  class RuntimePlayerClient { constructor() {} }
  class PresentationExecutor { constructor() {} cancelActive() {} }
  class BrowserPresentationRenderer {
    constructor() {} dispose() {} prepareTargetFrame() {} renderStoryScreens() {} applyFrame() {} restore() {}
  }

  const root = new HTMLElement();
  root.innerHTML = "";
  root.addEventListener = () => {};

  const storage = new Map();
  const sandbox = {
    HTMLElement, Element, HTMLFormElement,
    PlayerClientError, RuntimePlayerClient, PresentationExecutor, BrowserPresentationRenderer,
    createStoryScreens, isSelfActivatingControl, storyScreensInput, storyScreensKeyInput,
    storyScreensMission, storyScreensTurnApplied, storyScreensTurnRejected, storyScreensView,
    document: { querySelector: (selector) => (selector === "#app" ? root : null), addEventListener: () => {} },
    window: { location: { origin: "http://player.test" }, addEventListener: () => {} },
    sessionStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)); },
      removeItem: (key) => { storage.delete(key); }
    },
    crypto: globalThis.crypto,
    setTimeout, clearTimeout,
    fetch: (url, init) => server.handle(url, init)
  };
  sandbox.globalThis = sandbox;

  const transformed = `${stripped}\nglobalThis.__playerApp = { state, storyTurnGuard, commitStoryTurn, runStoryTurn, syncStoryTurnFromServer, applyStory, onClick, render, renderStoryShell, isTurnPosition, isId, escapeHtml, root };\n`;
  vm.createContext(sandbox);
  vm.runInContext(transformed, sandbox, { filename: "app.js" });
  await delay(5); // дать start() упасть на заглушке metadata и успокоиться

  const app = sandbox.__playerApp;
  assert.ok(app, "app.js должен быть исполнен в контексте");
  return app;
}

const META = Object.freeze({
  templateId: "minimal-paint",
  playtestId: "playtest-race",
  questTitle: "Квест",
  locationTitle: "Мастерская",
  sceneText: "текст",
  resourceId: "blue_paint",
  resourceTitle: "Краска",
  resourceUnit: "portion",
  actionId: "paint",
  actionTitle: "Рисовать"
});

function installStory(app) {
  app.state.meta = META;
  app.state.session = {
    templateId: "minimal-paint",
    sessionId: "player-session",
    credential: "P".repeat(32),
    lastOperationId: null,
    playerView: { revision: 0, resources: [], clock: { elapsedSeconds: 0 }, release: { releaseId: "release-1" } }
  };
  app.state.phase = "ready";
  app.state.story = { mission: mission(), screens: createStoryScreens(mission()), view: null, lastTurn: null, exited: false };
}

test("FIN-05 гонка: второй клик не отправляет второй POST и не откатывает ход", async () => {
  const server = createTurnServer();
  server.postLatency = (n) => (n === 1 ? 30 : 5); // первый клик медленный, второй быстрый
  const app = await loadPlayerApp(server);
  installStory(app);

  const before = app.state.story.screens;
  const first = app.commitStoryTurn({ choiceId: "go", baseTurn: 0 });
  const second = app.commitStoryTurn({ choiceId: "go", baseTurn: 0 });
  await Promise.all([first, second]);

  assert.equal(server.posts.length, 1, "два клика не дают двух POST с одним baseTurn");
  assert.equal(app.storyTurnGuard.inFlight, false, "блокировка снимается после ответа");
  assert.equal(app.state.story.screens.turns, 1);
  assert.equal(app.state.story.screens.sceneId, "painted", "применённый ход не откатывается");
  assert.notEqual(app.state.story.screens, before);
  assert.equal(app.state.story.lastTurn.turn, 1);
});

test("FIN-05 гонка: поздний ответ устаревшего ordinal игнорируется", async () => {
  const server = createTurnServer();
  // Лок делает перекрытие недопустимым через клики; ordinal — страж порядка
  // для уже отправленного запроса, чей ответ приходит позже нового.
  server.reply = async (_server, body, index) => {
    if (index === 1) {
      await delay(40); // старый запрос отвечает последним
      return jsonResponse(200, { state: { position: { turn: 5, sceneId: "painted", endingId: null } } });
    }
    await delay(3);
    return jsonResponse(200, { state: { position: { turn: 9, sceneId: "start", endingId: null } } });
  };
  const app = await loadPlayerApp(server);
  installStory(app);

  await Promise.all([
    app.runStoryTurn({ choiceId: "go", baseTurn: 0 }),
    app.runStoryTurn({ choiceId: "go", baseTurn: 0 })
  ]);

  assert.equal(server.posts.length, 2);
  assert.equal(app.state.story.screens.turns, 9, "старый ответ не перезаписывает более новый ход");
  assert.equal(app.state.story.screens.sceneId, "start");
});

test("FIN-05 гонка: TURN_CONFLICT синхронизирует через GET, а не откатывает позицию", async () => {
  const server = createTurnServer();
  const app = await loadPlayerApp(server);
  installStory(app);
  // Клиент уже применил ход 2 (позиция не должна откатиться к 0/2), сервер ушёл на 3.
  app.state.story.screens = storyScreensTurnApplied(createStoryScreens(mission()), {
    turn: 2, sceneId: "painted", endingId: null
  }).state;
  server.turn = 3;
  server.sceneId = "start";

  await app.commitStoryTurn({ choiceId: "go", baseTurn: 2 });

  assert.equal(server.posts.length, 1);
  assert.equal(server.gets, 1, "конфликт добирает авторитетное состояние через GET");
  assert.equal(app.state.story.screens.turns, 3, "позиция синхронизирована, а не откачена");
  assert.equal(app.state.story.screens.sceneId, "start");
  assert.match(app.state.message, /синхронизирован/i);

  // Главное: клиент не застревает — следующий ход уже уходит с актуальным baseTurn.
  await app.commitStoryTurn({ choiceId: "go", baseTurn: app.state.story.screens.turns });
  assert.equal(server.posts.length, 2);
  assert.equal(app.state.story.screens.turns, 4);
});

test("FIN-05 гонка: конфликт без доступного GET оставляет позицию и сообщает об этом", async () => {
  const server = createTurnServer();
  server.getFails = true;
  const app = await loadPlayerApp(server);
  installStory(app);
  server.turn = 1; // сервер ушёл вперёд, клиент на 0

  await app.commitStoryTurn({ choiceId: "go", baseTurn: 0 });

  assert.equal(server.gets, 1);
  assert.equal(app.state.story.screens.turns, 0, "позиция не меняется, ход не выдумывается");
  assert.match(app.state.message, /устарел/i);
});

test("FIN-05 XSS: позиция из ответа валидируется, иначе честный отказ", async () => {
  const server = createTurnServer();
  const app = await loadPlayerApp(server);
  installStory(app);
  const hostile = [
    { turn: "<img src=x onerror=alert(1)>", sceneId: "start", endingId: null },
    { turn: -1, sceneId: "start", endingId: null },
    { turn: 1.5, sceneId: "start", endingId: null },
    { turn: 1, sceneId: "<script>alert(1)</script>", endingId: null },
    { turn: 1, sceneId: 42, endingId: null },
    { turn: 1, sceneId: "start", endingId: "" },
    { turn: 1, sceneId: "start", endingId: "<img src=x>" },
    { turn: 1 },
    null
  ];
  for (const position of hostile) {
    assert.equal(app.isTurnPosition(position), false, `недоверенная позиция: ${JSON.stringify(position)}`);
  }
  assert.equal(app.isTurnPosition({ turn: 0, sceneId: "start", endingId: null }), true);
  assert.equal(app.isTurnPosition({ turn: 7, sceneId: "painted", endingId: "win" }), true);

  server.reply = async () => jsonResponse(200, { state: { position: { turn: "<img src=x onerror=alert(1)>", sceneId: "start", endingId: null } } });
  await app.commitStoryTurn({ choiceId: "go", baseTurn: 0 });

  assert.equal(app.state.story.screens.turns, 0, "ход с невалидной позицией не применяется");
  assert.equal(app.state.story.screens.sceneId, "start");
  assert.equal(app.state.story.lastTurn, null);
  assert.match(app.state.message, /без корректной позиции/i);
  assert.doesNotMatch(app.root.innerHTML, /<img/i, "ответ сервера не попадает в разметку сырым");
});

test("FIN-05 XSS: turn из ответа/позиции не интерполируется в innerHTML сырым", async () => {
  const server = createTurnServer();
  const app = await loadPlayerApp(server);
  installStory(app);
  const payload = "<img src=x onerror=alert(1)>";

  app.state.story.screens = Object.freeze({ ...app.state.story.screens, turns: payload });
  app.state.story.lastTurn = Object.freeze({ choiceId: payload, turn: payload });
  app.renderStoryShell();

  const html = app.root.innerHTML;
  assert.ok(html.length > 0, "экран истории отрисован");
  assert.doesNotMatch(html, /<img/i, "payload не стал элементом разметки");
  assert.match(html, /&lt;img/, "payload отрисован как экранированный текст");
  assert.match(html, /Ходы: &lt;img/);
});

test("FIN-05 ход не сломан: успешный ответ по-прежнему переводит по серверу", async () => {
  const server = createTurnServer();
  const app = await loadPlayerApp(server);
  installStory(app);

  await app.commitStoryTurn({ choiceId: "go", baseTurn: 0 });

  assert.equal(server.posts.length, 1);
  assert.equal(server.gets, 0, "успешный ход не ходит в GET");
  assert.equal(app.state.story.screens.turns, 1);
  assert.equal(app.state.story.screens.sceneId, "painted");
  assert.equal(app.state.story.lastTurn.choiceId, "go");
});
