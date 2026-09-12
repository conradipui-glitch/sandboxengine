/*
 * Тур из редактора и кнопка «Помощь» ДЕЙСТВИТЕЛЬНО работают в приложении.
 *
 * Страж от двух оборванных проводов, найденных визуальной приёмкой:
 *
 *  1) Тур. Кнопка data-action="start-tour" клала разметку шага в state.message,
 *     а статусная строка рендерит сообщение через escapeHtml — в DOM не
 *     появлялось ни одного [data-tour-step], автор видел экранированный HTML.
 *     Кнопок data-action="tour-next"/"tour-back"/"tour-skip" не существовало,
 *     хотя app.ts их обрабатывал. Здесь проверяется живой провод:
 *     в DOM есть шаг тура, есть кнопки перехода, они реально переключают шаги,
 *     текст статуса — без HTML-мусора.
 *
 *  2) Справка. Кнопка data-action="help-projects" писала строку в состояние и
 *     не открывала справку. Здесь проверяется, что она открывает СУЩЕСТВУЮЩИЙ
 *     диалог справки Studio (.lh-help-dialog модуля onboarding) и он закрывается.
 *
 * Запуск (после сборки dist): node --test apps/studio/test/tour-help-wiring.test.mjs
 * Мутации, на которых этот файл обязан краснеть:
 *   - убрать из рендера редактора шаг тура (renderOnboardingTourCard) или вернуть
 *     шаг в state.message — падают проверки 1;
 *   - заменить вызов открытия справки на запись строки в state.message — падают
 *     проверки 2.
 */

import test from "node:test";
import assert from "node:assert/strict";

/* ── Мини-DOM: разметка разбирается, события всплывают по-настоящему ───────── */

const VOID_TAGS = new Set(["img", "input", "br", "hr", "meta", "link", "source", "area", "base", "col", "embed", "param", "track", "wbr"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'" };

function unescapeEntities(text) {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_match, name) => ENTITIES[name]);
}

const datasetKey = (attribute) => attribute
  .slice("data-".length)
  .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());

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
    this.open = false;
    this.focused = false;
    this.scrolledIntoView = 0;
    this._html = "";
  }
  get classList() {
    return new FakeClassList(this);
  }
  get parentElement() {
    return this.parentNode;
  }
  get innerHTML() {
    return this._html;
  }
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
  removeAttribute(name) {
    delete this.attributes[name];
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
    for (const node of nodes) this.appendChild(node);
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) { this.children.splice(index, 1); child.parentNode = null; }
    return child;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== handler));
  }
  listenerCount(type) {
    return (this.listeners.get(type) ?? []).length;
  }
  /** Всплытие: обработчики вызываются от цели вверх по parentNode. */
  dispatch(type, event = {}) {
    const isRealEvent = event !== null && typeof event === "object" && typeof event.preventDefault === "function";
    const effective = isRealEvent ? event : { preventDefault() {}, stopPropagation() {}, ...event };
    if (!isRealEvent) effective.type = type;
    try {
      Object.defineProperty(effective, "target", { value: this, configurable: true });
    } catch { /* цель уже задана объектом события */ }
    let node = this;
    while (node) {
      for (const handler of [...(node.listeners?.get(type) ?? [])]) handler(effective);
      node = node.parentNode;
    }
    return effective;
  }
  dispatchEvent(event) {
    this.dispatch(event.type, event);
    return event.defaultPrevented !== true;
  }
  click() {
    this.dispatch("click", {});
  }
  matches(selector) {
    return String(selector).split(",").some((part) => matchesSelector(this, part.trim()));
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (typeof node.matches === "function" && node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
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
  focus() {
    this.focused = true;
    documentStub.activeElement = this;
  }
  scrollIntoView() {
    this.scrolledIntoView += 1;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 900, bottom: 700, width: 900, height: 700 };
  }
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
    assert.ok(close > 0, `незакрытый тег в разметке: ${html.slice(index, index + 60)}`);
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
      if (attribute[1] === "open") element.open = true;
    }
    stack[stack.length - 1].appendChild(element);
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(element);
  }
  return container;
}

/* ── Документ: у него есть body/head, и он видит дерево приложения ────────── */

const documentStub = {
  activeElement: null,
  head: new FakeElement("head"),
  // body появляется позже: модуль onboarding монтируется на document сам при
  // импорте, и в тесте мы хотим смонтировать его явно — на подготовленный body.
  body: null,
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_ns, tag) => new FakeElement(tag),
  elementFromPoint: () => null,
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  },
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
const { installStudioOnboarding } = await import("../dist/src/onboarding.js");

/* ── Фикстуры ────────────────────────────────────────────────────────────── */

const PROJECT_ID = "p-one";
const QUEST_ID = "q-one";

function draft() {
  return {
    projectId: PROJECT_ID,
    questId: QUEST_ID,
    draftRevision: 1,
    title: "Квест",
    entryLocationId: "yard",
    contentHash: "x".repeat(64),
    blocks: Object.freeze([])
  };
}

function bootApp({ projects = [], view = "editor", quests = [] } = {}) {
  const root = new FakeElement("div");
  // Корень живёт в body: documentAnchorProbe(document) ищет якоря тура
  // в настоящем дереве документа, как в браузере.
  ensureBody().appendChild(root);
  const api = {
    async listProjects() { return projects; },
    async listQuests() { return quests; },
    async listProjectAssets() { return []; }
  };
  const app = new StudioApp(root, api);
  app.state.access = Object.freeze({ mode: "local-owner", auth: null, mutationProof: true, members: null, membersError: null });
  app.state.view = view;
  app.state.projects = Object.freeze(projects);
  app.state.selectedProjectId = view === "editor" ? PROJECT_ID : null;
  app.state.selectedQuestId = view === "editor" ? QUEST_ID : null;
  app.state.quests = Object.freeze(quests);
  app.state.draft = view === "editor" ? draft() : null;
  app.state.mission = null;
  app.state.missionRevision = 0;
  app.state.boardPositions = new Map();
  app.state.boardView = "list";
  app.state.inspectorTab = "props";
  app.state.phase = "idle";
  app.state.message = "Готово.";
  app.render();
  return { app, root };
}

async function settle(times = 8) {
  for (let step = 0; step < times; step += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Текст узла целиком — включая вложенные элементы, как его читает автор. */
function visibleText(node) {
  let text = node.textContent ?? "";
  for (const child of node.children ?? []) text += ` ${visibleText(child)}`;
  return text;
}

/** body создаётся один раз на тест: до этого модуль onboarding не монтируется сам. */
function ensureBody() {
  if (!documentStub.body) documentStub.body = new FakeElement("body");
  return documentStub.body;
}

const PROJECTS = [{ projectId: PROJECT_ID, title: "Флоренция", role: "owner" }];
const QUESTS = [{ projectId: PROJECT_ID, questId: QUEST_ID, draftRevision: 1, title: "Квест", entryLocationId: "yard", contentHash: "x".repeat(64) }];

function clickAction(root, action) {
  const button = root.querySelector(`[data-action="${action}"]`);
  assert.ok(button, `в интерфейсе есть кнопка data-action="${action}"`);
  button.dispatch("click");
  return button;
}

/* ── 1. Тур из редактора: шаг виден, переключается, пропускается ──────────── */

test("тур из редактора: шаг тура виден в DOM, а не экранирован в статусной строке", async () => {
  const { root } = bootApp({ projects: PROJECTS, quests: QUESTS });
  await settle();
  clickAction(root, "start-tour");
  await settle();

  const card = root.querySelector("[data-tour-step]");
  assert.ok(card, "в интерфейсе есть реальный шаг тура ([data-tour-step])");
  assert.equal(card.getAttribute("data-tour-step"), "mission", "на экране редактора тур встаёт на шаг «Миссия»");

  const status = root.querySelector(".topbar-status");
  assert.ok(status, "статусная строка на месте");
  const statusText = visibleText(status);
  assert.doesNotMatch(statusText, /lh-tour-step|&lt;section|data-tour-step|<section/, "статус не содержит экранированного HTML шага");

  assert.ok(root.querySelector('[data-action="tour-next"]'), "есть кнопка «Далее»");
  assert.ok(root.querySelector('[data-action="tour-back"]'), "есть кнопка «Назад»");
  assert.ok(root.querySelector('[data-action="tour-skip"]'), "есть кнопка «Пропустить»");

  // Текст шага читается автором, без HTML-мусора.
  assert.match(visibleText(card), /Миссия — отдельная история/);
  assert.match(visibleText(card), /Шаг 3 из 10/);
});

test("тур из редактора: «Далее» и «Назад» действительно переключают шаги", async () => {
  const { root } = bootApp({ projects: PROJECTS, quests: QUESTS });
  await settle();
  clickAction(root, "start-tour");
  await settle();

  clickAction(root, "tour-next");
  await settle();
  assert.equal(root.querySelector("[data-tour-step]").getAttribute("data-tour-step"), "board", "шаг вперёд сменился");

  clickAction(root, "tour-back");
  await settle();
  assert.equal(root.querySelector("[data-tour-step]").getAttribute("data-tour-step"), "mission", "шаг назад вернулся");
});

test("тур из редактора: «Пропустить» закрывает тур", async () => {
  const { root } = bootApp({ projects: PROJECTS, quests: QUESTS });
  await settle();
  clickAction(root, "start-tour");
  await settle();
  assert.ok(root.querySelector("[data-tour-step]"), "тур шёл");

  clickAction(root, "tour-skip");
  await settle();
  assert.equal(root.querySelector("[data-tour-step]"), null, "после пропуска шага тура в интерфейсе нет");
  assert.doesNotMatch(visibleText(root.querySelector(".topbar-status")), /lh-tour-step/);
});

/* ── 2. Кнопка «Помощь» открывает существующий диалог справки ─────────────── */

test("кнопка «Помощь» открывает СУЩЕСТВУЮЩИЙ диалог справки Studio и он закрывается", async () => {
  storage.set("living-history.studio.onboarding.v1", "skipped"); // авто-тур не мешает
  ensureBody();
  const dispose = installStudioOnboarding(documentStub, { store: localStorageStub });
  try {
    const { root } = bootApp({ projects: [], view: "projects" });
    await settle();
    assert.equal(documentStub.querySelector(".lh-help-dialog"), null, "до нажатия справка закрыта");

    clickAction(root, "help-projects");
    await settle();

    assert.ok(documentStub.querySelector(".lh-help-dialog"), "нажатие «Помощь» открывает настоящий диалог справки");
    assert.match(visibleText(documentStub.querySelector(".lh-help-dialog")), /Справка Studio/);

    const close = documentStub.querySelector('[data-onboarding-action="close-help"]');
    assert.ok(close, "в диалоге справки есть кнопка закрытия");
    close.dispatch("click");
    await settle();
    assert.equal(documentStub.querySelector(".lh-help-dialog"), null, "справка закрывается");
  } finally {
    dispose();
  }
});
