// FIN-05 (Player): экраны истории intro/scene/dialogue/choice/ending на общем
// renderer'е Player. Чистая модель + реальный DOM-шим renderer + HTTP-route
// /player-story.json + связка app.js. Характеризующий набор: без модели или
// без метода renderStoryScreens он красный (см. отчёт: RED при отсутствии
// apps/player/dist/src/story-screens.js).

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQLiteControlStore } from "@living-history/control";
import { createPlayerDevServer } from "../dist/src/dev-server.js";
import {
  STORY_SCREENS_SCHEMA_VERSION,
  createStoryScreens,
  isSelfActivatingControl,
  reconcileStoryScreens,
  storyScreensIdentity,
  storyScreensInput,
  storyScreensMission,
  storyScreensKeyInput,
  storyScreensView
} from "../dist/src/story-screens.js";

const hash = (letter) => letter.repeat(64);
const asset = (id) => ({ assetId: id, hash: hash("a") });

function mission() {
  return {
    schemaVersion: "1.0",
    projectId: "project",
    questId: "quest",
    contentRevision: 1,
    contentHash: hash("c"),
    listing: {
      title: "Не-Florence история",
      slug: "mission-1",
      summary: "",
      coverAssetId: null,
      period: "",
      place: "",
      playerRole: "",
      estimatedMinutes: 10,
      supportedModes: ["choice"]
    },
    story: {
      entrySceneId: "start",
      scenes: [
        {
          id: "start",
          title: "Начало",
          text: "Вы у входа.",
          dialogue: [
            { id: "d1", speakerId: "npc", text: "Привет" },
            { id: "d2", speakerId: null, text: "Тишина" }
          ],
          choices: [
            { id: "go-a", label: "Налево", targetSceneId: "a", endingId: null, conditions: [], effects: [] },
            { id: "go-b", label: "Направо", targetSceneId: "b", endingId: null, conditions: [], effects: [] }
          ]
        },
        {
          id: "a",
          title: "Сцена A",
          text: "",
          dialogue: [{ id: "a1", speakerId: null, text: "Ответвление A" }],
          choices: [{ id: "end-1", label: "Финал 1", targetSceneId: null, endingId: "win", conditions: [], effects: [] }]
        },
        {
          id: "b",
          title: "Сцена B",
          text: "",
          dialogue: [],
          choices: [{ id: "end-2", label: "Финал 2", targetSceneId: null, endingId: "lose", conditions: [], effects: [] }]
        }
      ],
      endings: [
        { id: "win", title: "Победа", text: "Вы победили." },
        { id: "lose", title: "Поражение", text: "Конец." }
      ]
    },
    screens: {
      intros: [
        { id: "i1", title: "Вступление 1", body: "Первая страница.", background: null },
        { id: "i2", title: "Вступление 2", body: "Вторая страница.", background: asset("bg") }
      ],
      scenes: {
        start: { background: asset("bg-start"), inheritBackground: false, layers: [], music: null }
      },
      endings: {
        win: { background: null, inheritBackground: true, layers: [], music: null }
      }
    },
    defaults: { background: null, theme: "", animationPreset: "fade" }
  };
}

function screens() {
  return storyScreensMission(mission());
}

function advance(state, times = 1) {
  let current = state;
  for (let i = 0; i < times; i += 1) {
    const result = storyScreensInput(current, screens(), { kind: "advance" });
    current = result.state;
  }
  return current;
}

test("FIN-05 экраны: вступление листается «Далее/Начать» и не тратит ход", () => {
  const state = createStoryScreens(screens());
  assert.equal(state.phase, "intro");
  const first = storyScreensView(state, screens());
  assert.equal(first.intro.page, 1);
  assert.equal(first.intro.pageCount, 2);
  assert.equal(first.primary.label, "Далее");
  assert.equal(first.title, "Вступление 1");

  const step1 = storyScreensInput(state, screens(), { kind: "advance" });
  assert.equal(step1.handled, true);
  assert.equal(step1.turnRequest, null, "перелистывание вступления — не ход");
  assert.equal(step1.state.turns, 0);
  const second = storyScreensView(step1.state, screens());
  assert.equal(second.intro.page, 2);
  assert.equal(second.primary.label, "Начать", "последняя страница — «Начать», не «Далее»");
  assert.equal(second.title, "Вступление 2");

  const step2 = storyScreensInput(step1.state, screens(), { kind: "advance" });
  assert.equal(step2.state.phase, "scene");
  assert.equal(step2.state.sceneId, "start");
  assert.equal(step2.state.turns, 0, "старт игры из вступления не тратит ход");
  assert.equal(step2.turnRequest, null);
});

test("FIN-05 экраны: диалог листается по одной строке, выбор только после раскрытия", () => {
  const start = advance(createStoryScreens(screens()), 2);
  assert.equal(start.phase, "scene");
  const initial = storyScreensView(start, screens());
  assert.equal(initial.dialogue.length, 0);
  assert.equal(initial.choices.length, 0, "выборы не показываются до конца диалога");
  assert.equal(initial.primary.label, "Далее");

  // Выбор до раскрытия диалога отклоняется и не тратит ход.
  const early = storyScreensInput(start, screens(), { kind: "choose", choiceId: "go-a" });
  assert.equal(early.handled, false);
  assert.equal(early.turnRequest, null);
  assert.equal(early.state.turns, 0);

  const one = storyScreensInput(start, screens(), { kind: "advance" });
  assert.equal(one.state.revealed, 1, "один ввод раскрывает ровно одну строку");
  const viewOne = storyScreensView(one.state, screens());
  assert.equal(viewOne.dialogue.length, 1);
  assert.equal(viewOne.activeDialogueLineId, "d1");

  const two = storyScreensInput(one.state, screens(), { kind: "advance" });
  assert.equal(two.state.revealed, 2);
  const viewTwo = storyScreensView(two.state, screens());
  assert.equal(viewTwo.dialogue.length, 2);
  assert.equal(viewTwo.activeDialogueLineId, "d2");
  assert.equal(viewTwo.primary, null, "когда диалог раскрыт, primary уступает выборам");
  assert.deepEqual(viewTwo.choices.map((choice) => choice.choiceId), ["go-a", "go-b"]);

  // Диалог раскрыт — дальнейшее «вперёд» ничего не делает.
  const extra = storyScreensInput(two.state, screens(), { kind: "advance" });
  assert.equal(extra.handled, false);
});

test("FIN-05 экраны: выбор ведёт в сцену или финал и является единственным ходом", () => {
  const atChoices = advance(createStoryScreens(screens()), 4);
  assert.equal(atChoices.revealed, 2);

  const chosen = storyScreensInput(atChoices, screens(), { kind: "choose", choiceId: "go-a" });
  assert.equal(chosen.handled, true);
  assert.equal(chosen.state.phase, "scene");
  assert.equal(chosen.state.sceneId, "a");
  assert.equal(chosen.state.turns, 1);
  assert.deepEqual(chosen.turnRequest, { choiceId: "go-a", baseTurn: 0 });

  const revealed = storyScreensInput(chosen.state, screens(), { kind: "advance" });
  assert.equal(revealed.state.revealed, 1);
  const ending = storyScreensInput(revealed.state, screens(), { kind: "choose", choiceId: "end-1" });
  assert.equal(ending.state.phase, "ending");
  assert.equal(ending.state.endingId, "win");
  assert.equal(ending.state.turns, 2);
  assert.deepEqual(ending.turnRequest, { choiceId: "end-1", baseTurn: 1 });
  const endingView = storyScreensView(ending.state, screens());
  assert.equal(endingView.title, "Победа");
  assert.deepEqual(endingView.actions, { exit: true, repeat: true });
  assert.equal(endingView.primary, null);

  // Неизвестный и чужой выбор отклоняются без хода.
  const unknown = storyScreensInput(atChoices, screens(), { kind: "choose", choiceId: "nope" });
  assert.equal(unknown.handled, false);
  const wrongScene = storyScreensInput(chosen.state, screens(), { kind: "choose", choiceId: "end-1" });
  assert.equal(wrongScene.handled, false);
  assert.equal(wrongScene.state.turns, 1, "отклонённый выбор не тратит ход");
});

test("FIN-05 экраны: завершение — ветви дают два разных финала", () => {
  const toB = advance(createStoryScreens(screens()), 4);
  const chosen = storyScreensInput(toB, screens(), { kind: "choose", choiceId: "go-b" });
  assert.equal(chosen.state.sceneId, "b");
  const ending = storyScreensInput(chosen.state, screens(), { kind: "choose", choiceId: "end-2" });
  assert.equal(ending.state.endingId, "lose");
  assert.equal(storyScreensView(ending.state, screens()).title, "Поражение");
});

test("FIN-05 экраны: финал — выход и повтор", () => {
  let state = advance(createStoryScreens(screens()), 4);
  state = storyScreensInput(state, screens(), { kind: "choose", choiceId: "go-a" }).state;
  state = storyScreensInput(state, screens(), { kind: "advance" }).state;
  state = storyScreensInput(state, screens(), { kind: "choose", choiceId: "end-1" }).state;

  const exited = storyScreensInput(state, screens(), { kind: "exit" });
  assert.equal(exited.exited, true);
  assert.equal(exited.handled, true);
  assert.equal(exited.state.endingId, "win", "выход не меняет состояние истории");

  const repeated = storyScreensInput(state, screens(), { kind: "restart" });
  assert.equal(repeated.state.phase, "intro");
  assert.equal(repeated.state.introIndex, 0);
  assert.equal(repeated.state.turns, 0);
  assert.equal(repeated.exited, false);
});

test("FIN-05 экраны: позиция привязана к авторскому контенту, а не к объекту", () => {
  const first = storyScreensMission(mission());
  let state = advance(createStoryScreens(first), 3);
  assert.equal(state.revealed, 1);

  // Перерисовка той же истории другим объектом сохраняет позицию.
  const redrawn = storyScreensMission(mission());
  assert.equal(storyScreensIdentity(redrawn), storyScreensIdentity(first));
  assert.equal(reconcileStoryScreens(state, redrawn), state, "тот же контент — та же позиция");

  // Реальная правка сюжета (новый id сцены) начинает историю заново.
  const edited = mission();
  edited.story.scenes[0].id = "start-2";
  edited.story.entrySceneId = "start-2";
  assert.notEqual(storyScreensIdentity(storyScreensMission(edited)), storyScreensIdentity(first));
  assert.equal(reconcileStoryScreens(state, storyScreensMission(edited)).phase, "intro");
  assert.equal(reconcileStoryScreens(state, storyScreensMission(edited)).turns, 0);
});

test("FIN-05 экраны: клавиатура листает, но не отбирает клавишу у контрола и модификаторов", () => {
  for (const key of ["Enter", " ", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "PageDown"]) {
    assert.deepEqual(storyScreensKeyInput({ key }, false), { kind: "advance" }, key);
  }
  assert.equal(storyScreensKeyInput({ key: "x" }, false), null);
  assert.equal(storyScreensKeyInput({ key: "Escape" }, false), null);
  for (const modifier of ["ctrlKey", "metaKey", "altKey"]) {
    assert.equal(storyScreensKeyInput({ key: "Enter", [modifier]: true }, false), null, modifier);
  }
  assert.equal(storyScreensKeyInput({ key: "Enter" }, true), null, "клавиша на самоактивирующемся контроле не перехватывается");

  assert.equal(isSelfActivatingControl({ tagName: "BUTTON" }), true);
  assert.equal(isSelfActivatingControl({ tagName: "a" }), true);
  assert.equal(isSelfActivatingControl({ tagName: "INPUT" }), true);
  assert.equal(isSelfActivatingControl({ tagName: "DIV", role: "button" }), true);
  assert.equal(isSelfActivatingControl({ tagName: "DIV", getAttribute: () => "link" }), true);
  assert.equal(isSelfActivatingControl({ tagName: "DIV", contentEditable: true }), true);
  assert.equal(isSelfActivatingControl({ tagName: "DIV" }), false);
  assert.equal(isSelfActivatingControl(null), false);
  assert.equal(STORY_SCREENS_SCHEMA_VERSION, "1.0");
});

// --- Минимальный DOM-шим: проверяем реальный общий renderer без браузера ---

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.className = "";
    this.textContent = "";
    this.src = "";
    this.type = "";
    this.hidden = false;
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "class") this.className = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  addEventListener() {}
  removeEventListener() {}
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector) {
    const results = [];
    const attrMatch = selector.match(/^\[([^=\]]+)(?:="(.*)")?\]$/);
    const walk = (node) => {
      for (const child of node.children) {
        let ok = false;
        if (attrMatch) {
          const name = attrMatch[1];
          const dataKey = name.replace(/^data-/, "").replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
          if (name.startsWith("data-")) ok = child.dataset[dataKey] === attrMatch[2];
          else ok = child.attributes[name] === attrMatch[2];
        } else if (selector.startsWith(".")) {
          ok = (child.className || "").split(/\s+/).includes(selector.slice(1));
        } else if (selector === "#presentation-stage") {
          ok = child.attributes.id === "presentation-stage";
        } else {
          ok = child.tagName.toLowerCase() === selector.toLowerCase();
        }
        if (ok) results.push(child);
        walk(child);
      }
    };
    walk(this);
    return results;
  }
}

function makeDom() {
  const stage = new FakeElement("div");
  stage.setAttribute("id", "presentation-stage");
  const root = new FakeElement("div");
  root.appendChild(stage);
  const document = {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => {
      const node = new FakeElement("#text");
      node.textContent = String(text);
      return node;
    },
    querySelector: (selector) => root.querySelector(selector),
    querySelectorAll: (selector) => root.querySelectorAll(selector)
  };
  return { document, stage };
}

test("FIN-05 экраны: общий renderer Player рисует intro/dialogue/choice/ending без второго рендерера", async () => {
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const { document, stage } = makeDom();
  globalThis.document = document;
  globalThis.HTMLElement = FakeElement;
  try {
    const module = await import("../presentation-renderer.js");
    assert.deepEqual(Object.keys(module), ["BrowserPresentationRenderer"], "renderer тот же самый, без параллельного");
    const renderer = new module.BrowserPresentationRenderer(() => null);
    assert.equal(typeof renderer.renderStoryScreens, "function");

    // Вступление: кнопка навигации type=button (не submit формы).
    const introState = createStoryScreens(screens());
    await renderer.renderStoryScreens(storyScreensView(introState, screens()), () => Promise.resolve(null));
    const primary = stage.querySelector('[data-action="story-primary"]');
    assert.equal(primary.type, "button", "навигация вступления — не форма submit");
    assert.equal(primary.textContent, "Далее");
    assert.equal(stage.querySelector('[data-role="story-progress"]').textContent, "1 / 2");
    assert.equal(stage.querySelector('[data-role="story-screen"]').dataset.phase, "intro");

    // Последняя страница вступления — «Начать».
    const lastIntro = storyScreensInput(introState, screens(), { kind: "advance" }).state;
    await renderer.renderStoryScreens(storyScreensView(lastIntro, screens()), () => Promise.resolve(null));
    assert.equal(stage.querySelector('[data-action="story-primary"]').textContent, "Начать");

    // Сцена: диалоговые строки рисует общий renderer.
    const sceneState = storyScreensInput(lastIntro, screens(), { kind: "advance" }).state;
    const afterLine = storyScreensInput(sceneState, screens(), { kind: "advance" }).state;
    await renderer.renderStoryScreens(storyScreensView(afterLine, screens()), () => Promise.resolve(null));
    const lines = stage.querySelectorAll(".presentation-dialogue-line");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].dataset.active, "true");

    // Выборы: кнопки с choiceId.
    const atChoices = storyScreensInput(afterLine, screens(), { kind: "advance" }).state;
    await renderer.renderStoryScreens(storyScreensView(atChoices, screens()), () => Promise.resolve(null));
    const choiceButtons = stage.querySelectorAll('[data-action="story-choice"]');
    assert.deepEqual(choiceButtons.map((button) => button.dataset.choiceId), ["go-a", "go-b"]);
    assert.equal(choiceButtons[0].type, "button");

    // Финал: выход и повтор.
    let endingState = storyScreensInput(atChoices, screens(), { kind: "choose", choiceId: "go-b" }).state;
    endingState = storyScreensInput(endingState, screens(), { kind: "choose", choiceId: "end-2" }).state;
    await renderer.renderStoryScreens(storyScreensView(endingState, screens()), () => Promise.resolve(null));
    assert.equal(stage.querySelector('[data-action="story-exit"]').textContent, "Выход");
    assert.equal(stage.querySelector('[data-action="story-repeat"]').textContent, "Повторить");
    assert.equal(stage.querySelector('[data-role="story-screen"]').dataset.phase, "ending");

    // Фон: resolver с URL даёт <img>, без URL — честный fallback.
    const withAsset = storyScreensInput(createStoryScreens(screens()), screens(), { kind: "advance" }).state;
    await renderer.renderStoryScreens(storyScreensView(withAsset, screens()), () => Promise.resolve("/bg.png"));
    assert.equal(stage.querySelector('[data-role="story-background"]').querySelector("img").src, "/bg.png");
    await renderer.renderStoryScreens(storyScreensView(withAsset, screens()), () => Promise.resolve(null));
    assert.equal(stage.querySelector('[data-role="story-background"]').textContent, "Фон недоступен");
  } finally {
    globalThis.document = previousDocument;
    globalThis.HTMLElement = previousHTMLElement;
  }
});

// --- HTTP-поверхность Player ---

const metadata = Object.freeze({
  templateId: "minimal-paint",
  playtestId: "playtest-ui",
  questTitle: "Тестовый квест",
  locationTitle: "Мастерская",
  sceneText: "Текст.",
  resourceId: "blue_paint",
  resourceTitle: "Синяя краска",
  resourceUnit: "portion",
  actionId: "paint",
  actionTitle: "Рисовать"
});

test("FIN-05 экраны: Player отдаёт pinned историю на /player-story.json и модель для браузера", async (t) => {
  const player = createPlayerDevServer({
    runtimeOrigin: "http://127.0.0.1:9",
    metadata,
    story: { mission: mission() }
  });
  const { port } = await player.listen();
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(() => player.close());

  const response = await fetch(`${baseUrl}/player-story.json`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mission.story.entrySceneId, "start");
  assert.equal(body.mission.screens.intros.length, 2);
  assert.equal(body.mission.story.endings.length, 2);

  const model = await fetch(`${baseUrl}/player-assets/story-screens.js`);
  assert.equal(model.status, 200);
  assert.match(await model.text(), /storyScreensView/);

  const app = await fetch(`${baseUrl}/player-assets/app.js`);
  const code = await app.text();
  assert.match(code, /renderStoryScreens/);
  assert.match(code, /storyScreensKeyInput/);
  assert.match(code, /player-story\.json/);
  assert.match(code, /story-choice/);
  assert.match(code, /BrowserPresentationRenderer/, "используется общий renderer, а не второй");
});

test("FIN-05 экраны: без pinned истории Player отвечает 404 и остаётся paint-клиентом", async (t) => {
  const player = createPlayerDevServer({ runtimeOrigin: "http://127.0.0.1:9", metadata });
  const { port } = await player.listen();
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(() => player.close());

  assert.equal((await fetch(`${baseUrl}/player-story.json`)).status, 404);
  // Fail-closed: неполный mission document не принимается как история.
  assert.throws(
    () => createPlayerDevServer({ runtimeOrigin: "http://127.0.0.1:9", metadata, story: { mission: { story: {} } } }),
    /invalid Player story mission/
  );
});

test("FIN-05 экраны: реальный dev:player отдаёт pinned историю frozen playtest", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sandboxengine-player-story-"));
  const databasePath = join(directory, "living-history.sqlite");
  const store = new SQLiteControlStore({ path: databasePath });
  let child = null;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    store.close();
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

  // Автор сохраняет описанную историю (intro/scene/dialogue/choice/ending).
  const authored = mission();
  authored.projectId = "project";
  authored.questId = "quest";
  const saved = await store.saveMission("project", "quest", {
    baseRevision: 0,
    mission: authored,
    idempotencyKey: "fin05-story-save",
    actorUserId: "author"
  });
  assert.equal(saved.kind, "saved", JSON.stringify(saved.errors ?? saved.kind));
  assert.equal(saved.mission.contentRevision, 1);

  const frozen = await store.createPlaytest({
    projectId: "project",
    questId: "quest",
    draftRevision: 1,
    validationId: validated.validation.validationId
  });
  assert.equal(frozen.kind, "created");
  const playtestId = frozen.playtest.playtestId;
  store.close();

  const mainPath = fileURLToPath(new URL("../dist/src/main.js", import.meta.url));
  child = spawn(process.execPath, [mainPath], {
    env: { ...process.env, LH_DATABASE_PATH: databasePath, LH_PLAYTEST_ID: playtestId, LH_PLAYER_PORT: "0", LH_RUNTIME_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  const baseUrl = await waitForPlayerUrl(child, () => stderr);
  const story = await (await fetch(`${baseUrl}/player-story.json`)).json();
  assert.equal(story.mission.story.entrySceneId, "start");
  assert.equal(story.mission.screens.intros.length, 2);
  assert.equal(story.mission.story.endings.length, 2);

  // Тот же pinned контент доходит до общего renderer'а без второго рендерера.
  const { storyScreensMission: toScreens } = await import("../dist/src/story-screens.js");
  const screens = toScreens(story.mission);
  const first = storyScreensView(createStoryScreens(screens), screens);
  assert.equal(first.intro.page, 1);
  assert.equal(first.primary.label, "Далее");
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
  return Object.freeze({ schemaVersion: "1.0", id: "blue_paint", kind: "core.resource", title: "Синяя краска", description: "", data: Object.freeze({ unit: "portion", initialValue: 2, min: 0, max: 20 }) });
}

function paintActionBlock(cost) {
  return Object.freeze({
    schemaVersion: "1.0", id: "paint", kind: "core.action", title: "Рисовать", description: "Потратить краску.",
    data: Object.freeze({ actionType: "core.paint", resourceId: "blue_paint", resourceUnitsPerUnit: cost, durationSecondsPerUnit: 300, allowPartial: true })
  });
}
