// FIN-05 (Player): гонки хода истории и XSS-сток ответа сервера.
//
// Тест выполняет НАСТОЯЩИЙ apps/player/app.js: исходник читается с диска,
// импорты абсолютных путей Player переписываются на реальные dist-модули
// (story-screens.js) и минимальные стабы, после чего модуль поднимается в
// DOM-шиме поверх управляемого fetch. Поэтому любая правка app.js меняет
// поведение этих тестов (см. отчёт: мутации guard/валидации/экранирования).
//
// Проверяется:
//  (а) повторный клик во время полёта не отправляет и не применяет второй ход;
//  (б) поздний отказ не откатывает уже применённый ход, клиент остаётся
//      синхронным с сервером и следующий клик работает;
//  (в) вредоносная строка из ответа сервера не становится разметкой в DOM.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createStoryScreens,
  isStoryScreensTurnReply,
  storyScreensMission,
  storyScreensTurnApplied,
  storyScreensTurnFailureMessage
} from "../dist/src/story-screens.js";

const APP_PATH = fileURLToPath(new URL("../app.js", import.meta.url));
const STORY_SCREENS_DIST = fileURLToPath(new URL("../dist/src/story-screens.js", import.meta.url));
const PRESENTATION_RENDERER = fileURLToPath(new URL("../presentation-renderer.js", import.meta.url));

const HOSTILE = "<img src=x onerror=alert(1)>";
const HOSTILE_SCRIPT = "<script>alert(1)</script>";

const METADATA = Object.freeze({
  templateId: "minimal-paint",
  playtestId: "playtest-race",
  questTitle: "Гонки хода",
  locationTitle: "Мастерская",
  sceneText: "Текст.",
  resourceId: "paint",
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
    contentRevision: 1,
    contentHash: "c".repeat(64),
    listing: {
      title: "Гонки хода",
      slug: "player-race",
      summary: "",
      coverAssetId: null,
      period: "",
      place: "",
      playerRole: "",
      estimatedMinutes: 5,
      supportedModes: ["choice"]
    },
    story: {
      entrySceneId: "start",
      scenes: [
        {
          id: "start",
          title: "Начало",
          text: "",
          dialogue: [],
          choices: [{ id: "go-deep", label: "Глубже", targetSceneId: "deep", endingId: null, conditions: [], effects: [] }]
        },
        {
          id: "deep",
          title: "Глубина",
          text: "",
          dialogue: [],
          choices: [{ id: "go-mid", label: "Ещё", targetSceneId: "mid", endingId: null, conditions: [], effects: [] }]
        },
        {
          id: "mid",
          title: "Середина",
          text: "",
          dialogue: [],
          choices: [{ id: "go-end", label: "Финал", targetSceneId: null, endingId: "win", conditions: [], effects: [] }]
        }
      ],
      endings: [{ id: "win", title: "Победа", text: "" }]
    },
    screens: { intros: [], scenes: {}, endings: {} },
    defaults: { background: null, theme: "", animationPreset: "fade" }
  };
}

// --- Минимальный DOM-шим -------------------------------------------------

class ShimElement {
  constructor(tag = "DIV") {
    this.tagName = tag;
    this.dataset = {};
    this.closestTarget = null;
    this.innerHTML = "";
    this.textContent = "";
  }
  closest() { return this.closestTarget; }
  addEventListener() { /* listeners are captured by the shim root */ }
  querySelector() { return null; }
  setAttribute() { /* no-op */ }
  appendChild() { /* no-op */ }
  remove() { /* no-op */ }
}
class ShimHTMLElement extends ShimElement {}
class ShimFormElement extends ShimHTMLElement {}

function installGlobals({ root, listeners, turnRequests }) {
  const storage = new Map();
  globalThis.Element = ShimElement;
  globalThis.HTMLElement = ShimHTMLElement;
  globalThis.HTMLFormElement = ShimFormElement;
  globalThis.document = {
    querySelector(selector) { return selector === "#app" ? root : null; },
    createElement(tag) { return new ShimElement(String(tag).toUpperCase()); },
    createDocumentFragment() { return new ShimElement("#fragment"); }
  };
  globalThis.window = {
    location: { origin: "http://player.test" },
    addEventListener(type, handler) { (listeners[type] ??= []).push(handler); }
  };
  globalThis.sessionStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); }
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    const method = String(init.method ?? "GET").toUpperCase();
    if (url.endsWith("/player-meta.json")) return okJson(200, METADATA);
    if (url.endsWith("/player-story.json")) return okJson(200, { mission: mission() });
    if (url.endsWith("/player-turn.json") && method === "POST") {
      const record = { body: JSON.parse(String(init.body ?? "{}")), resolve: null, reject: null };
      record.promise = new Promise((resolve, reject) => { record.resolve = resolve; record.reject = reject; });
      turnRequests.push(record);
      return record.promise;
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
}

function okJson(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

// --- Загрузка настоящего app.js ------------------------------------------

const CLIENT_STUB = `
export class PlayerClientError extends Error {
  constructor(status, code) { super(String(code)); this.status = status; this.code = code; }
}
export class RuntimePlayerClient {
  constructor(baseUrl) { this.baseUrl = String(baseUrl); }
  async createSession(templateId) {
    const sessionId = "player-race-session-1";
    return Object.freeze({
      templateId,
      sessionId,
      credential: "C".repeat(32),
      presentationFrame: null,
      lastOperationId: null,
      playerView: Object.freeze({
        sessionId,
        revision: 0,
        resources: [],
        clock: Object.freeze({ elapsedSeconds: 0 }),
        release: Object.freeze({ releaseId: "release-race" })
      })
    });
  }
  async resume() { throw new Error("resume is not used by this harness"); }
  async reset(session) { return this.createSession(session.templateId); }
  async paint() { throw new Error("paint is not used by this harness"); }
}
`;

const EXECUTOR_STUB = `
export class PresentationExecutor {
  constructor(renderer) { this.renderer = renderer; }
  cancelActive() {}
  skipActive() {}
  async present() { return { outcome: "recovered", currentFrame: null }; }
  async restore(frame) { return { outcome: "recovered", currentFrame: frame }; }
}
`;

async function loadPlayer(t) {
  const directory = await mkdtemp(join(tmpdir(), "lh-player-race-"));
  if (t) t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }));

  const clientPath = join(directory, "client-stub.mjs");
  const executorPath = join(directory, "executor-stub.mjs");
  await writeFile(clientPath, CLIENT_STUB, "utf8");
  await writeFile(executorPath, EXECUTOR_STUB, "utf8");

  const source = await readFile(APP_PATH, "utf8");
  const rewritten = source
    .replace(/"\/player-lib\/client\.js"/, JSON.stringify(pathToFileURL(clientPath).href))
    .replace(/"\/player-lib\/presentation-executor\.js"/, JSON.stringify(pathToFileURL(executorPath).href))
    .replace(/"\/player-assets\/presentation-renderer\.js"/, JSON.stringify(pathToFileURL(PRESENTATION_RENDERER).href))
    .replace(/"\/player-assets\/story-screens\.js"/, JSON.stringify(pathToFileURL(STORY_SCREENS_DIST).href));
  assert.equal(rewritten.includes("/player-lib/client.js"), false, "импорты app.js переписаны на реальные модули и стабы");
  assert.equal(rewritten.includes("story-screens.js\""), true, "модель экранов подключена из dist");

  const entryPath = join(directory, "app-under-test.mjs");
  await writeFile(entryPath, rewritten, "utf8");

  const root = new ShimHTMLElement("MAIN");
  const listeners = {};
  const turnRequests = [];
  root.addEventListener = (type, handler) => { (listeners[type] ??= []).push(handler); };
  installGlobals({ root, listeners, turnRequests });

  await import(`${pathToFileURL(entryPath).href}?instance=${Math.random()}`);
  await settle(20);
  assert.match(root.innerHTML, /Ходы:/, "история загружена и отрисована");

  return {
    root,
    turnRequests,
    async settle(times = 20) { await settle(times); },
    click(action, data = {}) {
      const target = new ShimHTMLElement("BUTTON");
      target.dataset = { action, ...data };
      target.closestTarget = target;
      for (const handler of listeners.click ?? []) handler({ target });
    },
    async choose(choiceId) {
      this.click("story-choice", { choiceId });
      await this.settle();
    },
    turnCount() {
      const match = /Ходы:\s*([^<]*)/.exec(root.innerHTML);
      return match === null ? null : match[1].trim();
    },
    respond(index, status, body) {
      turnRequests[index].resolve(okJson(status, body));
    },
    fail(index, error = new TypeError("network down")) {
      turnRequests[index].reject(error);
    }
  };
}

async function settle(times) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function position(turn, sceneId, endingId = null) {
  return { state: { position: { turn, sceneId, endingId, terminal: false, target: null } } };
}

// --- (а) повторная отправка нереентерабельна ------------------------------

test("FIN-05 гонка хода: клик во время полёта не отправляет второй ход и не применяется дважды", async (t) => {
  const player = await loadPlayer(t);
  assert.equal(player.turnCount(), "0");

  await player.choose("go-deep");
  assert.equal(player.turnRequests.length, 1, "первый клик отправляет ровно один ход");
  assert.equal(player.turnRequests[0].body.baseTurn, 0);
  assert.equal(player.turnRequests[0].body.choiceId, "go-deep");

  // Второй и третий клики приходят, пока ответ сервера ещё не пришёл.
  player.click("story-choice", { choiceId: "go-deep" });
  player.click("story-choice", { choiceId: "go-deep" });
  await player.settle();
  assert.equal(player.turnRequests.length, 1, "повторные клики игнорируются, пока ход в полёте");
  assert.equal(player.turnCount(), "0", "второй ход не применён ложно");

  // Ответ приходит позже и применяется один раз.
  player.respond(0, 200, position(1, "deep"));
  await player.settle();
  assert.equal(player.turnCount(), "1");
  assert.match(player.root.innerHTML, /выбор go-deep/);

  // После завершения полёта ввод снова доступен.
  await player.choose("go-mid");
  assert.equal(player.turnRequests.length, 2, "следующий ход отправляется после завершения предыдущего");
  assert.equal(player.turnRequests[1].body.baseTurn, 1, "базовый ход взят из применённого состояния");
  player.respond(1, 200, position(2, "mid"));
  await player.settle();
  assert.equal(player.turnCount(), "2");
});

// --- (б) поздний отказ не откатывает применённое состояние ----------------

test("FIN-05 гонка хода: поздний отказ не откатывает применённый ход, клиент остаётся синхронным", async (t) => {
  const player = await loadPlayer(t);

  await player.choose("go-deep");
  player.respond(0, 200, position(1, "deep"));
  await player.settle();
  assert.equal(player.turnCount(), "1");

  // Ход #2 уходит и получает поздний отказ: состояние не откатывается.
  await player.choose("go-mid");
  player.respond(1, 409, { error: { code: "TURN_CONFLICT" } });
  await player.settle();
  assert.equal(player.turnCount(), "1", "отказ сервера не откатывает уже применённый ход");
  assert.match(player.root.innerHTML, /устарел/);

  // Клиент снова синхронен с сервером: baseTurn = 1, а не 0.
  await player.choose("go-mid");
  assert.equal(player.turnRequests.length, 3, "повторный клик после отказа снова отправляет ход");
  assert.equal(player.turnRequests[2].body.baseTurn, 1);
  player.respond(2, 200, position(2, "mid"));
  await player.settle();
  assert.equal(player.turnCount(), "2");

  // Сетевой отказ тоже не залипает: следующий клик работает.
  await player.choose("go-end");
  player.fail(3);
  await player.settle();
  assert.equal(player.turnCount(), "2", "сетевой отказ не меняет позицию");
  assert.match(player.root.innerHTML, /недоступен/);

  await player.choose("go-end");
  assert.equal(player.turnRequests.length, 5, "после сетевого отказа ход можно повторить");
  assert.equal(player.turnRequests[4].body.baseTurn, 2);
  player.respond(4, 200, position(3, "mid", "win"));
  await player.settle();
  assert.equal(player.turnCount(), "3");
});

test("FIN-05 гонка хода: устаревший ответ предыдущей сессии не применяется", async (t) => {
  const player = await loadPlayer(t);

  await player.choose("go-deep");
  assert.equal(player.turnRequests.length, 1);
  const staleSession = player.turnRequests[0].body.sessionId;

  // «Повторить историю» разрешено во время полёта и аннулирует его.
  player.click("story-repeat");
  await player.settle();
  assert.equal(player.turnCount(), "0", "история начата заново");

  player.respond(0, 200, position(7, "mid"));
  await player.settle();
  assert.equal(player.turnCount(), "0", "поздний ответ старой сессии не применяется");
  assert.doesNotMatch(player.root.innerHTML, /Ходы: 7/);

  // Новая сессия хода: другой sessionId, baseTurn 0.
  await player.choose("go-deep");
  assert.equal(player.turnRequests.length, 2);
  assert.notEqual(player.turnRequests[1].body.sessionId, staleSession);
  assert.equal(player.turnRequests[1].body.baseTurn, 0);
  player.respond(1, 200, position(1, "deep"));
  await player.settle();
  assert.equal(player.turnCount(), "1");
});

// --- (в) XSS-сток ---------------------------------------------------------

test("FIN-05 XSS: модель отвергает ответ сервера с нечисловым/вредоносным ходом", () => {
  const screens = createStoryScreens(storyScreensMission(mission()));

  const hostileTurn = storyScreensTurnApplied(screens, { turn: HOSTILE, sceneId: "deep", endingId: null });
  assert.equal(hostileTurn.ok, false, "строка вместо хода не применяется");
  assert.equal(hostileTurn.state, screens, "состояние остаётся прежним");

  const hostileScene = storyScreensTurnApplied(screens, { turn: 1, sceneId: HOSTILE, endingId: null });
  assert.equal(hostileScene.ok, false, "разметка вместо sceneId не применяется");
  assert.equal(hostileScene.state, screens);

  const hostileEnding = storyScreensTurnApplied(screens, { turn: 1, sceneId: "deep", endingId: HOSTILE_SCRIPT });
  assert.equal(hostileEnding.ok, false, "разметка вместо endingId не применяется");

  assert.equal(isStoryScreensTurnReply({ turn: "1", sceneId: "deep", endingId: null }), false);
  assert.equal(isStoryScreensTurnReply({ turn: -1, sceneId: "deep", endingId: null }), false);
  assert.equal(isStoryScreensTurnReply({ turn: 1, sceneId: "deep", endingId: null }), true);

  // Ход назад (устаревший ответ) не откатывает уже применённое состояние.
  const advanced = storyScreensTurnApplied(screens, { turn: 3, sceneId: "mid", endingId: null });
  assert.equal(advanced.ok, true);
  const regress = storyScreensTurnApplied(advanced.state, { turn: 1, sceneId: "start", endingId: null });
  assert.equal(regress.ok, false, "ход назад не применяется");
  assert.equal(regress.state, advanced.state);
});

test("FIN-05 XSS: вредоносный ответ сервера не становится разметкой в DOM", async (t) => {
  const player = await loadPlayer(t);

  await player.choose("go-deep");
  player.respond(0, 200, position(HOSTILE, "deep"));
  await player.settle();

  const html = player.root.innerHTML;
  assert.equal(player.turnCount(), "0", "вредоносный ход не применён");
  assert.equal(/<img|<script/i.test(html), false, "разметка из ответа сервера не попала в DOM");
  assert.equal(html.includes("onerror"), false, "мусор от сервера не попал в разметку вообще");

  // Мусор вместо position тоже не ломает рендер.
  await player.choose("go-deep");
  player.respond(1, 200, { state: { position: HOSTILE } });
  await player.settle();
  assert.equal(player.turnCount(), "0");
  assert.equal(/<img|<script/i.test(player.root.innerHTML), false);

  // Строка сервера, которая обычно попадает в сообщение, экранируется.
  await player.choose("go-deep");
  player.respond(2, 500, { error: { code: HOSTILE } });
  await player.settle();
  const messageHtml = player.root.innerHTML;
  assert.equal(/<img|<script/i.test(messageHtml), false, "код ошибки сервера не стал элементом");
  assert.match(messageHtml, /&lt;img/, "вредоносная строка видна только как экранированный текст");
  assert.equal(storyScreensTurnFailureMessage({ network: false, status: 500, code: HOSTILE }).includes(HOSTILE), true);
});
