/*
 * Зона GUIDE — UI-тест панели «Создание миссии за 5 шагов» в живом приложении
 * (StudioApp). Страж от оборванных проводов, как tour-help-wiring:
 *
 *  1) помощник ДЕЙСТВИТЕЛЬНО появляется в редакторе: в document есть
 *     [data-mission-guide] с чек-листом и прогрессом, а не только в состоянии;
 *  2) галочки отмечаются реальными действиями автора: создали сцену с текстом —
 *     шаг 2 отмечен, добавили ресурс — шаг 4 отмечен; при этом app.ts вызывает
 *     update() на каждом рендере (мутация «убрать вызов» красит тест);
 *  3) валидная свежая проверка -> панель показывает «Всё готово к публикации»
 *     и кнопку «Открыть публикацию»;
 *  4) «Скрыть» убирает панель и сохраняет решение в localStorage;
 *  5) на экране проектов панель спит, в редакторе — просыпается.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/* ── Мини-DOM (как в tour-help-wiring.test.mjs) ──────────────────────────── */

const VOID_TAGS = new Set(["img", "input", "br", "hr", "meta", "link", "source", "area", "base", "col", "embed", "param", "track", "wbr"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'" };

function unescapeEntities(text) {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_match, name) => ENTITIES[name]);
}

const datasetKey = (attribute) => attribute
  .slice("data-".length)
  .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());

class FakeClassList {
  constructor(element) { this.element = element; }
  get tokens() { return new Set(String(this.element.className).split(/\s+/).filter(Boolean)); }
  write(tokens) { this.element.className = [...tokens].join(" "); }
  add(...names) { const tokens = this.tokens; for (const name of names) tokens.add(name); this.write(tokens); }
  remove(...names) { const tokens = this.tokens; for (const name of names) tokens.delete(name); this.write(tokens); }
  contains(name) { return this.tokens.has(name); }
}

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
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.focused = false;
    this.scrolledIntoView = 0;
    this._html = "";
  }
  get classList() { return new FakeClassList(this); }
  get parentElement() { return this.parentNode; }
  get innerHTML() { return this._html; }
  set innerHTML(value) {
    const html = String(value);
    this._html = html;
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.textContent = "";
    const parsed = parseMarkup(html);
    for (const child of [...parsed.children]) this.appendChild(child);
  }
  setAttribute(name, value) {
    const text = String(value);
    this.attributes[name] = text;
    if (name === "class") this.className = text;
    if (name.startsWith("data-")) this.dataset[datasetKey(name)] = text;
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }
  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }
  removeAttribute(name) { delete this.attributes[name]; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  replaceChildren(...nodes) { this.children = []; for (const node of nodes) this.appendChild(node); }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) { this.children.splice(index, 1); child.parentNode = null; }
    return child;
  }
  remove() { this.parentNode?.removeChild(this); }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== handler));
  }
  dispatch(type, event = {}) {
    const isRealEvent = event !== null && typeof event === "object" && typeof event.preventDefault === "function";
    const effective = isRealEvent ? event : { preventDefault() {}, stopPropagation() {}, ...event };
    if (!isRealEvent) effective.type = type;
    try { Object.defineProperty(effective, "target", { value: this, configurable: true }); } catch {}
    let node = this;
    while (node) {
      for (const handler of [...(node.listeners?.get(type) ?? [])]) handler(effective);
      node = node.parentNode;
    }
    return effective;
  }
  dispatchEvent(event) { this.dispatch(event.type, event); return event.defaultPrevented !== true; }
  click() { this.dispatch("click", {}); }
  matches(selector) { return String(selector).split(",").some((part) => matchesSelector(this, part.trim())); }
  closest(selector) {
    let node = this;
    while (node) {
      if (typeof node.matches === "function" && node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children ?? []) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  focus() { this.focused = true; documentStub.activeElement = this; }
  scrollIntoView() { this.scrolledIntoView += 1; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 900, bottom: 700, width: 900, height: 700 }; }
}

function matchesSelector(element, selector) {
  const text = String(selector).trim();
  if (text.startsWith("#")) return element.getAttribute("id") === text.slice(1);
  const tagMatch = text.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
  let rest = text;
  if (tagMatch) {
    if (element.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
    rest = text.slice(tagMatch[1].length);
  }
  const partRe = /(?:\.([-a-zA-Z0-9_]+))|(?:\[([-a-zA-Z0-9_]+)(?:=["']([^"']*)["'])?\])/g;
  let index = 0;
  let parts = 0;
  let match;
  while ((match = partRe.exec(rest)) !== null) {
    if (match.index !== index) return false;
    index = partRe.lastIndex;
    parts += 1;
    if (match[1] !== undefined) {
      if (!String(element.className ?? "").split(/\s+/).includes(match[1])) return false;
    } else {
      const attribute = match[2];
      if (!element.hasAttribute(attribute)) return false;
      if (match[3] !== undefined && element.getAttribute(attribute) !== match[3]) return false;
    }
  }
  if (parts === 0 && !tagMatch) return false;
  if (tagMatch && rest.length > 0 && index !== rest.length) return false;
  return true;
}

const ATTRIBUTE_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:=["']([^"']*)["'])?/g;

function parseMarkup(html) {
  const container = new FakeElement("div");
  const stack = [container];
  let index = 0;
  while (index < html.length) {
    if (html[index] !== "<") {
      const next = html.indexOf("<", index);
      const end = next === -1 ? html.length : next;
      stack[stack.length - 1].textContent += unescapeEntities(html.slice(index, end));
      index = end;
      continue;
    }
    const close = html.indexOf(">", index);
    if (!(close > 0)) break;
    const raw = html.slice(index + 1, close);
    index = close + 1;
    if (raw.startsWith("/")) {
      const tag = raw.slice(1).trim().toLowerCase();
      for (let depth = stack.length - 1; depth >= 1; depth -= 1) {
        if (stack[depth].tagName.toLowerCase() === tag) { stack.length = depth; break; }
      }
      continue;
    }
    const selfClosing = raw.endsWith("/");
    const body = (selfClosing ? raw.slice(0, -1) : raw).trim();
    const space = body.search(/\s/);
    const tag = (space === -1 ? body : body.slice(0, space)).toLowerCase();
    const attrText = space === -1 ? "" : body.slice(space + 1);
    const element = new FakeElement(tag);
    ATTRIBUTE_RE.lastIndex = 0;
    let attribute;
    while ((attribute = ATTRIBUTE_RE.exec(attrText)) !== null) {
      element.setAttribute(attribute[1], attribute[2] === undefined ? "" : unescapeEntities(attribute[2]));
    }
    stack[stack.length - 1].appendChild(element);
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(element);
  }
  return container;
}

const documentStub = {
  activeElement: null,
  head: new FakeElement("head"),
  body: null,
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_ns, tag) => new FakeElement(tag),
  elementFromPoint: () => null,
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
  querySelectorAll(selector) {
    const found = [];
    for (const root of [this.head, this.body]) {
      if (!root) continue;
      for (const child of root.children ?? []) {
        if (child.matches(selector)) found.push(child);
        found.push(...child.querySelectorAll(selector));
      }
    }
    return found;
  },
  listeners: new Map(),
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  },
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== handler));
  }
};

const storage = new Map();
const localStorageStub = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); }
};

globalThis.Element = FakeElement;
globalThis.HTMLElement = FakeElement;
globalThis.HTMLFormElement = FakeElement;
globalThis.document = documentStub;
globalThis.localStorage = localStorageStub;
globalThis.MutationObserver = undefined;
globalThis.window = {
  location: { origin: "http://127.0.0.1", href: "http://127.0.0.1/" },
  setTimeout: (callback) => { if (typeof callback === "function") callback(); return 0; },
  clearTimeout: () => {},
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {}
};
globalThis.EventSource = class { addEventListener() {} close() {} };
globalThis.FormData = class { get() { return null; } getAll() { return []; } };
globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => null });

const { StudioApp } = await import("../dist/src/app.js");
const { MISSION_GUIDE_STORAGE_KEY, readMissionGuideStatus } = await import("../dist/src/mission-guide.js");

/* ── Фикстуры ────────────────────────────────────────────────────────────── */

const PROJECT_ID = "p-guide";
const QUEST_ID = "q-guide";

function draft() {
  return {
    projectId: PROJECT_ID,
    questId: QUEST_ID,
    draftRevision: 1,
    title: "Квест",
    entryLocationId: "yard",
    contentHash: "a".repeat(64),
    blocks: Object.freeze([])
  };
}

/** Скелетная миссия, как её создаёт createMission. */
function skeletonMission() {
  return {
    story: {
      entrySceneId: "s-1",
      scenes: [{ id: "s-1", title: "Начало", text: "", choices: [{ id: "c-1", label: "Завершить" }] }],
      endings: [{ id: "e-1" }]
    }
  };
}

function ensureBody() {
  if (!documentStub.body) documentStub.body = new FakeElement("body");
  return documentStub.body;
}

const PROJECTS = [{ projectId: PROJECT_ID, title: "Проект-песочница", role: "owner" }];

function bootApp({ view = "editor", mission = null, blocks = [], validation = null } = {}) {
  const root = new FakeElement("div");
  ensureBody().appendChild(root);
  const api = {
    async listProjects() { return []; },
    async listQuests() { return []; },
    async listProjectAssets() { return []; }
  };
  const app = new StudioApp(root, api);
  app.state.access = Object.freeze({ mode: "local-owner", auth: null, mutationProof: true, members: null, membersError: null });
  app.state.view = view;
  // Проект обязан быть в списке: renderEditor при «!project» честно
  // переворачивает view в projects, и помощник должен спать — так и в жизни.
  app.state.projects = Object.freeze(view === "editor" ? PROJECTS : []);
  app.state.selectedProjectId = view === "editor" ? PROJECT_ID : null;
  app.state.selectedQuestId = view === "editor" ? QUEST_ID : null;
  app.state.draft = view === "editor" ? { ...draft(), blocks } : null;
  app.state.mission = mission;
  app.state.missionRevision = 1;
  // Полная форма ValidationView (errors обязателен для validationPanel).
  app.state.validation = validation
    ? { ...validation, validationId: "v-1", projectId: PROJECT_ID, questId: QUEST_ID, errors: [], compiledContentHash: null }
    : null;
  app.state.boardPositions = new Map();
  app.state.boardView = "list";
  app.state.inspectorTab = "props";
  app.state.phase = "idle";
  app.state.message = "Готово.";
  app.render();
  return { app, root };
}

function visibleText(node) {
  let text = node.textContent ?? "";
  for (const child of node.children ?? []) text += ` ${visibleText(child)}`;
  return text;
}

function guidePanel() {
  return documentStub.querySelector("[data-mission-guide]");
}

async function settle(times = 6) {
  for (let step = 0; step < times; step += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/* ── 1. Панель реально появляется в редакторе ────────────────────────────── */

test("GUIDE UI: первый вход в редактор показывает панель с чек-листом и прогрессом", async () => {
  storage.clear();
  documentStub.body = null;
  const { app } = bootApp({ mission: skeletonMission() });
  try {
    await settle();
    const panel = guidePanel();
    assert.ok(panel, "панель помощника есть в document (не в root — переживает перерисовки)");
    assert.match(visibleText(panel), /Создание миссии за 5 шагов/);
    assert.match(visibleText(panel), /Готово 1 из 5/, "скелет отмечает только шаг 1");
    assert.ok(panel.querySelector("[data-guide-action=\"hide\"]"), "есть кнопка «Скрыть помощника»");
    assert.ok(panel.querySelector("[data-guide-action=\"goto\"]"), "у текущего шага есть кнопка действия");
    assert.match(visibleText(panel), /Создайте сцену/, "текущий шаг — первый неотмеченный");
    // Решение «показывать» сохранено: перезагрузка страницы его не теряет.
    assert.equal(storage.get(MISSION_GUIDE_STORAGE_KEY), "active");
    assert.equal(readMissionGuideStatus(localStorageStub), "active");
  } finally {
    app.destroy();
  }
});

test("GUIDE UI: на экране проектов панель спит, возврат в редактор возвращает её", async () => {
  storage.clear();
  documentStub.body = null;
  const { app } = bootApp({ view: "projects" });
  try {
    await settle();
    assert.equal(guidePanel(), null, "на проектах помощник не показывается");
    app.state.view = "editor";
    app.state.projects = Object.freeze(PROJECTS);
    app.state.selectedProjectId = PROJECT_ID;
    app.state.selectedQuestId = QUEST_ID;
    app.state.draft = draft();
    app.state.mission = skeletonMission();
    app.render();
    await settle();
    assert.ok(guidePanel(), "в редакторе панель проснулась");
  } finally {
    app.destroy();
  }
});

/* ── 2. Галочки по реальным действиям автора ─────────────────────────────── */

test("GUIDE UI: написанная сцена и ресурс автора отмечают шаги 2 и 4", async () => {
  storage.clear();
  documentStub.body = null;
  const authored = {
    story: {
      entrySceneId: "s-1",
      scenes: [{ id: "s-1", title: "Начало", text: "Ты в тёмном коридоре.", choices: [{ id: "c-1", label: "Завершить" }] }],
      endings: [{ id: "e-1" }]
    }
  };
  const { app } = bootApp({ mission: authored, blocks: [{ kind: "core.location", id: "loc-1", title: "Старт", data: { unit: "шт", initialValue: 0, min: 0, max: 0 } }] });
  try {
    await settle();
    assert.match(visibleText(guidePanel()), /Готово 2 из 5/, "текст сцены — шаг 2 отмечен");

    app.state.draft = {
      ...draft(),
      blocks: [
        { kind: "core.location", id: "loc-1", title: "Старт", data: { unit: "шт", initialValue: 0, min: 0, max: 0 } },
        { kind: "core.resource", id: "res-1", title: "Краска", data: { unit: "порция", initialValue: 2, min: 0, max: 8 } }
      ]
    };
    app.render();
    await settle();
    assert.match(visibleText(guidePanel()), /Готово 3 из 5/, "ресурс — шаг 4 отмечен");
  } finally {
    app.destroy();
  }
});

/* ── 3. Валидная проверка -> «Всё готово к публикации» ───────────────────── */

test("GUIDE UI: свежая valid проверка показывает готовность и кнопку публикации", async () => {
  storage.clear();
  documentStub.body = null;
  const { app } = bootApp({
    mission: skeletonMission(),
    validation: { status: "valid", draftRevision: 1, contentHash: "a".repeat(64) }
  });
  try {
    await settle();
    const panel = guidePanel();
    assert.ok(panel, "панель на месте");
    assert.ok(panel.querySelector("[data-guide-ready=\"true\"]"), "блок готовности показан");
    assert.match(visibleText(panel), /Всё готово к публикации/);
    assert.ok(panel.querySelector("[data-guide-action=\"publish\"]"), "есть кнопка «Открыть публикацию»");
  } finally {
    app.destroy();
  }
});

test("GUIDE UI: устаревшая проверка (revision изменился) НЕ показывает готовность", async () => {
  storage.clear();
  documentStub.body = null;
  const { app } = bootApp({
    mission: skeletonMission(),
    validation: { status: "valid", draftRevision: 1, contentHash: "a".repeat(64) },
    __stale: true
  });
  try {
    await settle();
    // draft в bootApp имеет revision 1; сделаем черновик «новее» проверки.
    app.state.draft = { ...draft(), draftRevision: 2 };
    app.render();
    await settle();
    assert.equal(guidePanel().querySelector("[data-guide-ready=\"true\"]"), null, "проверка устарела — готовности нет");
    assert.doesNotMatch(visibleText(guidePanel()), /Всё готово к публикации/);
  } finally {
    app.destroy();
  }
});

/* ── 4. «Скрыть» убирает панель и запоминает решение ─────────────────────── */

test("GUIDE UI: «Скрыть помощника» прячет панель до перезагрузки и сохраняет hidden", async () => {
  storage.clear();
  documentStub.body = null;
  const { app } = bootApp({ mission: skeletonMission() });
  try {
    await settle();
    const hide = guidePanel().querySelector("[data-guide-action=\"hide\"]");
    assert.ok(hide, "кнопка скрытия доступна");
    hide.dispatch("click");
    await settle();
    assert.equal(guidePanel(), null, "после скрытия панели в document нет");
    assert.equal(storage.get(MISSION_GUIDE_STORAGE_KEY), "hidden", "решение сохранено");

    app.render();
    await settle();
    assert.equal(guidePanel(), null, "перерисовка не возвращает скрытую панель");
  } finally {
    app.destroy();
  }
});

/* ── 5. Интеграция не оборвана: app.ts вызывает update() на рендере ──────── */

test("GUIDE UI: провод app.ts -> помощник не оборван (вызов update в render, dispose в destroy)", async () => {
  const appSource = await readFile(new URL("../src/app.ts", import.meta.url), "utf8");
  assert.match(appSource, /updateMissionGuide\(\)/, "render вызывает обновление помощника");
  assert.match(appSource, /missionGuide\.update\(/, "факты о миссии передаются помощнику");
  assert.match(appSource, /missionGuide\?\.dispose\(\)/, "destroy снимает панель");
  assert.match(appSource, /from "\.\/mission-guide\.js"/, "модуль помощника импортирован");
  // Мутация-страж: если вернуть панель В root, она будет умирать на каждой перерисовке.
  assert.ok(!/this\.root\.innerHTML\s*=\s*`[^`]*mission-guide/.test(appSource), "панель не рендерится внутрь root");
});
