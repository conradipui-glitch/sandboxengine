/*
 * B13 — сцены и финалы квеста на «Доске» Studio.
 *
 * Дефект приёмки: представление «Доска» рисовало только карточки блоков проекта,
 * и правка сцены (текст, фон) не была видна и недоступна с доски. Здесь
 * проверяется, что сюжетный слой доски — отдельный от блоков: карточки сцен и
 * финалов выводятся из ДОКУМЕНТА миссии, связи-выборы рисуются как связи доски,
 * выбор карточки сцены ведёт в тот же путь правки (selectedStoryNodeId →
 * инспектор сцены в «Свойствах» → saveMission с baseRevision).
 *
 * Запуск (после сборки dist): node --test apps/studio/test/board-story-nodes.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

/* ── Мини-DOM: доска и shell работают на делегированных событиях ────────── */

class FakeClassList {
  constructor(element) {
    this.element = element;
  }
  get tokens() {
    return new Set(String(this.element.className).split(/\s+/).filter(Boolean));
  }
  write(tokens) {
    this.element.className = [...tokens].join(" ");
  }
  add(...names) {
    const tokens = this.tokens;
    for (const name of names) tokens.add(name);
    this.write(tokens);
  }
  remove(...names) {
    const tokens = this.tokens;
    for (const name of names) tokens.delete(name);
    this.write(tokens);
  }
  contains(name) {
    return this.tokens.has(name);
  }
}

const datasetKey = (attribute) =>
  attribute
    .slice("data-".length)
    .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

class FakeElement {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.className = "";
    this.textContent = "";
    this.title = "";
    this.offsetHeight = 112;
    this.clientWidth = 0;
    this.value = "";
  }
  get classList() {
    return new FakeClassList(this);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "class") this.className = String(value);
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  addEventListener(type, handler, options = {}) {
    const entry = { handler, signal: options?.signal ?? null };
    const list = this.listeners.get(type) ?? [];
    list.push(entry);
    this.listeners.set(type, list);
    if (entry.signal) {
      entry.signal.addEventListener("abort", () => {
        this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== entry));
      });
    }
  }
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item.handler !== handler));
  }
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    let node = this;
    while (node) {
      for (const entry of [...(node.listeners.get(event.type) ?? [])]) entry.handler.call(node, event);
      node = node.parentNode;
    }
    return true;
  }
  matches(selector) {
    return String(selector).split(",").some((part) => this.matchesSimple(part.trim()));
  }
  matchesSimple(selector) {
    if (!selector) return false;
    const tokens = selector.match(/^[a-zA-Z]+|[.#][\w-]+|\[[^\]]+\]/g) ?? [];
    return tokens.every((token) => {
      if (token.startsWith(".")) return this.classList.contains(token.slice(1));
      if (token.startsWith("[")) {
        const match = token.match(/^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/);
        if (!match) return false;
        const [, attribute, expected] = match;
        const actual = attribute.startsWith("data-")
          ? this.dataset[datasetKey(attribute)]
          : this.getAttribute(attribute);
        return expected === undefined ? actual !== undefined && actual !== null : actual === expected;
      }
      return this.tagName === token.toUpperCase();
    });
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (typeof node.matches === "function" && node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 900, bottom: 700, width: 900, height: 700 };
  }
  setPointerCapture() {}
  releasePointerCapture() {}
}

const documentStub = {
  activeElement: null,
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_ns, tag) => new FakeElement(tag),
  elementFromPoint: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  listeners: new Map(),
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  },
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== handler));
  }
};

const rafQueue = [];
globalThis.Element = FakeElement;
globalThis.HTMLElement = FakeElement;
globalThis.HTMLFormElement = FakeElement;
globalThis.document = documentStub;
globalThis.window = {
  location: { origin: "http://127.0.0.1", href: "http://127.0.0.1/" },
  setTimeout: (callback) => {
    if (typeof callback === "function") callback();
    return 0;
  },
  clearTimeout: () => {},
  requestAnimationFrame: (callback) => {
    rafQueue.push(callback);
    return rafQueue.length;
  },
  cancelAnimationFrame: () => {}
};
/** Присутствие монтируется вместе с доской: поток не открываем, соединение не нужно. */
globalThis.EventSource = class {
  addEventListener() {}
  close() {}
};
/** Форма-заглушка: значения подставляет сам тест. */
let formValues = new Map();
globalThis.FormData = class {
  get(name) {
    return formValues.has(name) ? formValues.get(name) : null;
  }
  getAll() {
    return [];
  }
};

const { draftToBoard, missionToBoardStory, storyBoardFallbackPosition, STORY_BAND_OFFSET_X } =
  await import("../dist/src/board-model.js");
const { mountBoard } = await import("../dist/src/board-dom.js");
const { StudioApp } = await import("../dist/src/app.js");

/* ── Фикстуры: черновик блоков и документ миссии ─────────────────────────── */

const SCHEMA_VERSION = "1.0";

function block(id, kind, title, data) {
  return { schemaVersion: SCHEMA_VERSION, id, kind, title, description: "", data };
}

function draft() {
  return {
    projectId: "p",
    questId: "q",
    draftRevision: 1,
    title: "Квест",
    entryLocationId: "yard",
    contentHash: "x".repeat(64),
    blocks: [
      block("yard", "core.location", "Двор депо", {}),
      block("master", "core.character", "Мастер", { initialLocationId: "yard", initialStatus: "idle" }),
      block("paint", "core.resource", "Краска", { unit: "portion", initialValue: 2, min: 0, max: 5 }),
      block("paint-action", "core.action", "Красить", {
        actionType: "core.paint", resourceId: "paint", resourceUnitsPerUnit: 1, durationSecondsPerUnit: 60, allowPartial: true
      })
    ]
  };
}

function mission() {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: "p",
    questId: "q",
    contentRevision: 1,
    contentHash: "c".repeat(64),
    listing: {},
    story: {
      entrySceneId: "depot",
      scenes: [
        {
          id: "depot", title: "Депо", text: "Ночь. Мастер ждёт у ворот.", dialogue: [],
          choices: [
            { id: "c1", label: "На пути", targetSceneId: "tracks", endingId: null, conditions: [], effects: [] },
            { id: "c2", label: "Сразу финал", targetSceneId: null, endingId: "lost", conditions: [], effects: [] }
          ]
        },
        {
          id: "tracks", title: "Пути", text: "Тупик между вагонами.", dialogue: [],
          choices: [{ id: "c3", label: "Открыть", targetSceneId: null, endingId: "found", conditions: [], effects: [] }]
        }
      ],
      endings: [
        { id: "found", title: "Найден", text: "Ящики на месте." },
        { id: "lost", title: "Потерян", text: "Рассвело без него." }
      ]
    },
    screens: { intros: [], scenes: {}, endings: {} },
    defaults: { background: null, theme: "", animationPreset: "" }
  };
}

function boardModel(positions = new Map(), doc = mission()) {
  return draftToBoard(draft(), positions, doc);
}

const pointer = (type, { x = 0, y = 0, button = 0 } = {}) => ({
  type,
  clientX: x,
  clientY: y,
  button,
  pointerId: 1,
  pointerType: "mouse",
  preventDefault() {},
  stopPropagation() {}
});

/* ── 1. Проекция: сюжетный слой на доске ─────────────────────────────────── */

test("B13 board: сцены и финалы выводятся на доску отдельным слоем, не трогая блоки", () => {
  const model = boardModel();
  // блоки остались ровно теми же четырьмя карточками
  assert.deepEqual(model.nodes.map((node) => node.type).sort(), ["action", "character", "location", "resource"]);
  assert.equal(model.edges.length, 2, "связи блоков (персонаж→место, действие→ресурс) на месте");

  assert.deepEqual(model.storyNodes.map((node) => node.id), ["depot", "tracks", "found", "lost"]);
  const depot = model.storyNodes.find((node) => node.id === "depot");
  assert.equal(depot.kind, "scene");
  assert.equal(depot.title, "Депо");
  assert.equal(depot.text, "Ночь. Мастер ждёт у ворот.", "карточка сцены несёт авторский текст");
  assert.equal(depot.isEntry, true, "входная сцена помечена");
  assert.equal(depot.choiceCount, 2);
  const found = model.storyNodes.find((node) => node.id === "found");
  assert.equal(found.kind, "ending", "финал отличается признаком, а не только цветом");
  assert.equal(found.isEntry, false);
  assert.equal(found.choiceCount, 0);

  // Сюжетная полоса не наезжает на колонки блоков.
  const maxBlockX = Math.max(...model.nodes.map((node) => node.x));
  assert.ok(
    model.storyNodes.every((node) => node.x >= STORY_BAND_OFFSET_X),
    "сюжетные карточки стоят в своей полосе правее блоков"
  );
  assert.ok(STORY_BAND_OFFSET_X > maxBlockX);
});

test("B13 board: выборы между сценами видны как переходы с подписью решения", () => {
  const model = boardModel();
  assert.equal(model.storyEdges.length, 3);
  const toTracks = model.storyEdges.find((edge) => edge.source === "depot" && edge.target === "tracks");
  assert.equal(toTracks.kind, "story-choice");
  assert.equal(toTracks.label, "На пути → Пути");
  assert.ok(model.storyEdges.some((edge) => edge.target === "found" && edge.label === "Открыть → Найден"));
  assert.ok(model.storyEdges.some((edge) => edge.target === "lost" && edge.label === "Сразу финал → Потерян"));
});

test("B13 board: без документа миссии доска остаётся блоковой (обратная совместимость)", () => {
  const model = draftToBoard(draft());
  assert.deepEqual(model.storyNodes, []);
  assert.deepEqual(model.storyEdges, []);
  assert.equal(model.nodes.length, 4);
});

test("B13 board: сохранённая позиция story:<id> побеждает fallback, а правка текста видна проекции", () => {
  const saved = new Map([["story:tracks", { x: 1234, y: 567 }]]);
  const story = missionToBoardStory(mission(), saved);
  const tracks = story.nodes.find((node) => node.id === "tracks");
  assert.deepEqual({ x: tracks.x, y: tracks.y }, { x: 1234, y: 567 });
  const fallback = storyBoardFallbackPosition("scene", 0);
  assert.deepEqual(story.nodes.find((node) => node.id === "depot"), {
    kind: "scene", id: "depot", title: "Депо", text: "Ночь. Мастер ждёт у ворот.",
    isEntry: true, choiceCount: 2, x: fallback.x, y: fallback.y
  });
  assert.deepEqual(missionToBoardStory(null), { nodes: [], edges: [] });

  // Правка текста сцены (то, что сохраняет инспектор) попадает в проекцию доски.
  const edited = mission();
  edited.story.scenes[1].text = "Тупик. На стене свежая надпись.";
  const after = missionToBoardStory(edited).nodes.find((node) => node.id === "tracks");
  assert.equal(after.text, "Тупик. На стене свежая надпись.");
});

/* ── 2. DOM доски: карточки сцен/финалов и их связи ──────────────────────── */

function mount(options = {}) {
  const host = new FakeElement("div");
  const events = { moved: [], selected: [], connected: [] };
  const board = mountBoard(host, {
    model: options.model ?? boardModel(),
    editable: options.editable ?? true,
    onMove: (id, x, y) => events.moved.push({ id, x, y }),
    onSelect: (id) => events.selected.push(id),
    onConnect: (source, target) => events.connected.push({ source, target })
  });
  const cards = host.querySelectorAll(".board-node");
  return { host, board, events, cards, card: (id) => cards.find((item) => item.dataset.nodeId === id) };
}

test("B13 board DOM: карточка сцены показывает заголовок и признак финала", () => {
  const { card } = mount();
  const scene = card("depot");
  assert.ok(scene, "карточки сцены нет на доске");
  assert.ok(scene.classList.contains("board-story-node"));
  assert.ok(scene.classList.contains("story-node"));
  assert.ok(scene.classList.contains("story-node-scene"));
  assert.match(scene.querySelector(".node-kind").textContent, /Сцена/);
  assert.equal(scene.querySelector(".node-title").textContent, "Депо");
  assert.match(scene.querySelector(".node-desc").textContent, /Ночь\. Мастер ждёт/);
  assert.match(scene.querySelector(".entry-badge").textContent, /Вход/);
  assert.match(scene.querySelector(".node-meta").textContent, /Выборов: 2/);

  const ending = card("found");
  assert.ok(ending.classList.contains("story-node-ending"), "финал помечен отдельным классом (штриховая рамка)");
  assert.match(ending.querySelector(".node-kind").textContent, /Финал/);
  assert.equal(ending.querySelector(".entry-badge"), null);
  assert.match(ending.querySelector(".node-meta").textContent, /Конец истории/);

  // Карточка блока не изменилась и не получила сюжетных классов.
  const location = card("yard");
  assert.ok(location, "карточка места исчезла с доски");
  assert.equal(location.classList.contains("board-story-node"), false);
  assert.equal(location.dataset.blockKind, "location");
  assert.equal(location.querySelector(".node-kind").textContent, "Место");
});

test("B13 board DOM: связи-выборы рисуются тем же механизмом, что связи блоков", () => {
  const { host } = mount();
  const paths = host.querySelectorAll(".board-edge");
  const kinds = paths.map((path) => path.getAttribute("data-edge-kind"));
  assert.equal(kinds.filter((kind) => kind === "story-choice").length, 3);
  assert.equal(kinds.filter((kind) => kind === "character-initial-location").length, 1);
  assert.equal(kinds.filter((kind) => kind === "action-resource").length, 1);
  const labels = host.querySelectorAll(".board-edge-label").map((label) => label.textContent);
  assert.ok(labels.includes("На пути → Пути"), `подписи переходов: ${labels.join(" | ")}`);
  for (const path of paths) {
    assert.match(String(path.getAttribute("d")), /^M /);
    assert.equal(path.getAttribute("marker-end"), "url(#board-arrowhead)", "у связи есть стрелка, как у блочных");
  }
});

test("B13 board DOM: выбор карточки сцены сообщает её id — тот же путь выбора, что в «Сюжете»", () => {
  const { card, events } = mount();
  const body = card("tracks").querySelector(".node-body");
  body.dispatchEvent(pointer("pointerdown", { x: 10, y: 10 }));
  card("tracks").dispatchEvent(pointer("pointerup", { x: 10, y: 10 }));
  assert.deepEqual(events.selected, ["tracks"]);
  assert.equal(events.connected.length, 0, "у сцены нет портов: связь жестом не создаётся");

  // Перетаскивание сюжетной карточки отдаёт тот же id — позиция сохраняема.
  const moved = mount();
  moved.card("depot").querySelector(".node-head").dispatchEvent(pointer("pointerdown", { x: 10, y: 10 }));
  moved.card("depot").dispatchEvent(pointer("pointermove", { x: 120, y: 90 }));
  moved.card("depot").dispatchEvent(pointer("pointerup", { x: 120, y: 90 }));
  const last = moved.events.moved.at(-1);
  assert.equal(last.id, "depot");
  assert.ok(last.x > 0 && last.y > 0, `карточка сцены не сдвинулась: ${JSON.stringify(last)}`);
});

test("B13 board DOM: клик по фону и выбор карточки блока не задевают сюжетный слой", () => {
  const { card, events } = mount();
  card("paint").querySelector(".node-body").dispatchEvent(pointer("pointerdown", { x: 5, y: 5 }));
  card("paint").dispatchEvent(pointer("pointerup", { x: 5, y: 5 }));
  assert.deepEqual(events.selected, ["paint"], "блок выбирается как раньше");
  assert.equal(card("paint").classList.contains("board-story-node"), false);
});

/* ── 3. Studio: выбор с доски ведёт в тот же инспектор и тот же путь сохранения ── */

function appRoot() {
  const host = new FakeElement("div");
  const listeners = new Map();
  const root = {
    innerHTML: "",
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
    removeEventListener() {},
    querySelector(selector) {
      return String(selector).includes("data-board-host") ? host : null;
    },
    querySelectorAll() {
      return [];
    },
    dispatch(type, event) {
      for (const handler of listeners.get(type) ?? []) handler(event);
    }
  };
  return { root, host };
}

function bootApp({ saves } = { saves: [] }) {
  const { root, host } = appRoot();
  const api = {
    async listProjects() {
      return [];
    },
    async saveMission(projectId, questId, baseRevision, doc, idempotencyKey) {
      saves.push({ projectId, questId, baseRevision, doc, idempotencyKey });
      return { mission: { ...doc, contentRevision: baseRevision + 1 }, replay: false };
    }
  };
  const app = new StudioApp(root, api);
  app.state.access = Object.freeze({ mode: "local-owner", auth: null, mutationProof: true, members: null, membersError: null });
  app.state.view = "editor";
  app.state.projects = Object.freeze([{ projectId: "p", title: "Проект", role: "owner" }]);
  app.state.selectedProjectId = "p";
  app.state.selectedQuestId = "q";
  app.state.quests = Object.freeze([{
    projectId: "p", questId: "q", draftRevision: 1, title: "Квест", entryLocationId: "yard", contentHash: "x".repeat(64)
  }]);
  app.state.draft = draft();
  app.state.mission = mission();
  app.state.missionRevision = 1;
  app.state.boardPositions = new Map();
  app.state.boardView = "board";
  app.render();
  return { app, root, host };
}

test("B13 Studio: выбор сцены на «Доске» открывает инспектор сцены в «Свойствах»", () => {
  const { app, root, host } = bootApp();
  // Доска смонтирована на карточках блоков и сюжета.
  assert.equal(host.querySelectorAll(".board-node").length, 8, "на доске 4 блока + 4 сюжетных узла");

  // Клик по карточке сцены на доске (тот же жест, что у блока).
  const sceneCard = host.querySelectorAll(".board-node").find((node) => node.dataset.nodeId === "depot");
  assert.ok(sceneCard, "карточки сцены нет на живой доске");
  sceneCard.querySelector(".node-body").dispatchEvent(pointer("pointerdown", { x: 10, y: 10 }));
  sceneCard.dispatchEvent(pointer("pointerup", { x: 10, y: 10 }));

  assert.equal(app.state.selectedStoryNodeId, "depot", "выбор с доски задаёт выбранную сцену");
  assert.equal(app.state.selectedBoardNodeId, null);
  assert.match(root.innerHTML, /data-form="story-node-edit"/);
  assert.match(root.innerHTML, /data-form="story-node-edit" data-node-id="depot"/);
  assert.match(root.innerHTML, /Выборы \(2\)/, "инспектор сцены — тот же, что в «Сюжете»");
  assert.match(root.innerHTML, /Оформление экрана/);
  assert.doesNotMatch(root.innerHTML, /data-form="inspector-save"/, "на доске открыт инспектор сцены, а не карточки блока");
});

test("B13 Studio: правка текста сцены с «Доски» идёт тем же путём (saveMission + baseRevision)", async () => {
  const saves = [];
  const { app, root, host } = bootApp({ saves });
  const sceneCard = host.querySelectorAll(".board-node").find((node) => node.dataset.nodeId === "depot");
  sceneCard.querySelector(".node-body").dispatchEvent(pointer("pointerdown", { x: 10, y: 10 }));
  sceneCard.dispatchEvent(pointer("pointerup", { x: 10, y: 10 }));

  // Форму сцены на доске отправляем так же, как это делает автор.
  const form = new FakeElement("form");
  form.dataset.form = "story-node-edit";
  form.dataset.nodeId = "depot";
  formValues = new Map([
    ["title", "Депо (правка с доски)"],
    ["text", "Ночь. Текст, изменённый прямо с доски."]
  ]);
  root.dispatch("submit", { target: form, preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(saves.length, 1, "сохранение идёт одним запросом документа миссии");
  assert.equal(saves[0].projectId, "p");
  assert.equal(saves[0].questId, "q");
  assert.equal(saves[0].baseRevision, 1, "CAS по baseRevision соблюдён");
  const savedScene = saves[0].doc.story.scenes.find((scene) => scene.id === "depot");
  assert.equal(savedScene.text, "Ночь. Текст, изменённый прямо с доски.");
  assert.equal(savedScene.title, "Депо (правка с доски)");
  assert.match(app.state.message, /Свойства сохранены/);
  assert.equal(app.state.missionRevision, 2);

  // После сохранения текст виден проекции доски (то же представление, что после перезагрузки).
  const model = boardModel(app.state.boardPositions, app.state.mission);
  assert.equal(model.storyNodes.find((node) => node.id === "depot").text, "Ночь. Текст, изменённый прямо с доски.");
  assert.equal(model.storyNodes.find((node) => node.id === "depot").title, "Депо (правка с доски)");
});

test("B13 Studio: выбор карточки блока на «Доске» по-прежнему открывает инспектор карточки", () => {
  const { app, root } = bootApp();
  app.state.selectedStoryNodeId = null;
  app.state.selectedBoardNodeId = "paint";
  app.render();
  assert.match(root.innerHTML, /data-form="inspector-save"/);
  assert.doesNotMatch(root.innerHTML, /data-form="story-node-edit"/);
  assert.equal(app.state.selectedBoardNodeId, "paint");
});
