import test from "node:test";
import assert from "node:assert/strict";

// FIN-10 — DOM-шим для проверки самого overlay-тура: подсветка реальных узлов,
// Назад/Далее/Пропустить/Повторить, сохранённый прогресс, Esc + возврат фокуса,
// роль-зависимый шаг и русская ошибка с действием.

function attrToDatasetAttr(name) {
  return name.replace(/^data-/, "").replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
}

function matches(el, selector) {
  const tagMatch = selector.match(/^([A-Za-z][A-Za-z0-9-]*)/);
  let rest = selector;
  if (tagMatch) {
    if (el.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
    rest = selector.slice(tagMatch[1].length);
  }
  const clause = /\[([^\]]+)\]|\.([A-Za-z0-9_-]+)|#([A-Za-z0-9_-]+)/g;
  let m;
  while ((m = clause.exec(rest)) !== null) {
    if (m[0].startsWith("[")) {
      const body = m[1];
      const eq = body.indexOf("=");
      if (eq === -1) {
        if (!(body in el.attributes)) return false;
      } else {
        const key = body.slice(0, eq);
        const value = body.slice(eq + 1).replace(/^"|"$/g, "");
        const viaAttr = el.attributes[key] === value;
        const viaData = el.dataset[attrToDatasetAttr(key)] === value;
        if (!viaAttr && !viaData) return false;
      }
    } else if (m[0].startsWith(".")) {
      if (!el.classList.contains(m[2])) return false;
    } else if (m[0].startsWith("#")) {
      if (el.id !== m[3]) return false;
    }
  }
  return true;
}

function walk(node, out) {
  for (const child of node.children) {
    out.push(child);
    walk(child, out);
  }
  return out;
}

globalThis.Element = class Element {};

class FakeElement extends globalThis.Element {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.className = "";
    this.textContent = "";
    this.handlers = {};
    this.disabled = false;
    this.id = "";
    this.type = "";
    this.style = {};
    this._innerHTML = "";
  }
  get classList() {
    const self = this;
    const parse = () => (self.className || "").split(/\s+/).filter(Boolean);
    return {
      add: (...names) => { const set = new Set(parse()); names.forEach((n) => set.add(n)); self.className = [...set].join(" "); },
      remove: (...names) => { const set = new Set(parse()); names.forEach((n) => set.delete(n)); self.className = [...set].join(" "); },
      contains: (name) => parse().includes(name)
    };
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) { this._innerHTML = String(value); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) { this.children.splice(i, 1); child.parentNode = null; } return child; }
  get firstChild() { return this.children[0] ?? null; }
  setAttribute(name, value) {
    const string = String(value);
    if (name === "id") this.id = string;
    if (name === "class") this.className = string;
    this.attributes[name] = string;
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, handler) { (this.handlers[type] ??= []).push(handler); }
  removeEventListener(type, handler) { const list = this.handlers[type]; if (list) { const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1); } }
  dispatch(type, event) { for (const handler of this.handlers[type] ?? []) handler(event); }
  remove() { this.parentNode?.removeChild(this); }
  closest(selector) {
    let node = this;
    while (node) {
      if (matches(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) { return walk(this, []).filter((el) => matches(el, selector)); }
  focus() {
    if (globalThis.document) globalThis.document.activeElement = this;
  }
}

function element(tag, init = {}) {
  const el = new FakeElement(tag);
  if (init.className) el.className = init.className;
  if (init.id) el.id = init.id;
  if (init.text) el.textContent = init.text;
  if (init.attrs) for (const [k, v] of Object.entries(init.attrs)) el.attributes[k] = String(v);
  if (init.data) for (const [k, v] of Object.entries(init.data)) el.dataset[k] = String(v);
  return el;
}

function makeDocument() {
  const doc = {
    head: new FakeElement("head"),
    body: new FakeElement("body"),
    activeElement: null,
    handlers: {},
    createElement: (tag) => new FakeElement(tag),
    addEventListener(type, handler) { (doc.handlers[type] ??= []).push(handler); },
    removeEventListener(type, handler) { const list = doc.handlers[type]; if (list) { const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1); } },
    dispatch(type, event) { for (const handler of doc.handlers[type] ?? []) handler(event); },
    querySelector(selector) { return [...walk(doc.head, []), ...walk(doc.body, [])].find((el) => matches(el, selector)) ?? null; },
    querySelectorAll(selector) { return [...walk(doc.head, []), ...walk(doc.body, [])].filter((el) => matches(el, selector)); }
  };
  return doc;
}

function makeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

// Реальный авторский путь: узлы существуют в app.ts и присутствуют на экране.
function buildStudioTree(doc, { roleLabel = "Редактор" } = {}) {
  const app = element("div", { id: "app" });
  const projects = element("div", { className: "projects-screen" });
  const start = element("form", { attrs: { "data-form": "ai-draft" } });
  const emptyStart = element("form", { attrs: { "data-form": "empty-draft" } });
  const board = element("button", { attrs: { "data-action": "board-view", "data-view": "board" } });
  const screens = element("button", { attrs: { "data-action": "board-view", "data-view": "story" } });
  const validation = element("section", { className: "ed-validation validation-section" });
  const publication = element("button", { attrs: { "data-action": "toggle-editor-menu" } });
  const roleBadge = element("span", { className: "role-badge", text: roleLabel });
  app.append(projects, start, emptyStart, board, screens, validation, publication, roleBadge);
  doc.body.appendChild(app);
  return { app, projects, start, board, screens, validation, publication, roleBadge };
}

function clickAction(host, action) {
  const button = element("button");
  button.setAttribute("data-onboarding-action", action);
  button.dataset.onboardingAction = action;
  host.dispatch("click", { target: button, preventDefault() {} });
}

async function withStudio(options, run) {
  const previousDocument = globalThis.document;
  const previousLocalStorage = globalThis.localStorage;
  const previousObserver = globalThis.MutationObserver;
  const previousWindow = globalThis.window;
  const doc = makeDocument();
  const storage = makeStorage(options.storage);
  globalThis.document = doc;
  globalThis.localStorage = storage;
  globalThis.MutationObserver = undefined;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const tree = buildStudioTree(doc, options);
  const { installStudioOnboarding } = await import("../dist/src/onboarding.js");
  const dispose = installStudioOnboarding(doc);
  const host = doc.querySelector("#studio-onboarding-layer");
  const trigger = doc.querySelector("#studio-help-trigger");
  try {
    await run({ doc, storage, tree, host, trigger, dispose });
  } finally {
    dispose();
    globalThis.document = previousDocument;
    globalThis.localStorage = previousLocalStorage;
    globalThis.MutationObserver = previousObserver;
    globalThis.window = previousWindow;
  }
}

test("FIN-10 tour starts on the real path, highlights an existing node, saves progress and offers back/next/skip", async () => {
  await withStudio({}, async ({ storage, tree, host }) => {
    assert.match(host.innerHTML, /Шаг 1 из 7/);
    assert.match(host.innerHTML, /Проекты и идея/);
    assert.match(host.innerHTML, /Пропустить/);
    assert.match(host.innerHTML, /Назад/);
    assert.match(host.innerHTML, /Далее/);
    assert.ok(tree.projects.classList.contains("lh-tour-highlight"), "highlights a node that really exists");

    clickAction(host, "tour-next");
    assert.match(host.innerHTML, /Шаг 2 из 7/);
    assert.equal(JSON.parse(storage.getItem("living-history.studio.onboarding.progress.v1")).index, 1);
    assert.ok(!tree.projects.classList.contains("lh-tour-highlight"), "previous highlight removed");
    assert.ok(tree.start.classList.contains("lh-tour-highlight"), "next step highlights the start form");

    clickAction(host, "tour-back");
    assert.match(host.innerHTML, /Шаг 1 из 7/);
    assert.equal(JSON.parse(storage.getItem("living-history.studio.onboarding.progress.v1")).index, 0);

    clickAction(host, "tour-skip");
    assert.equal(storage.getItem("living-history.studio.onboarding.v1"), "skipped");
    assert.equal(storage.getItem("living-history.studio.onboarding.progress.v1"), null, "progress cleared on skip");
    assert.equal(host.innerHTML, "");
  });
});

test("FIN-10 saved progress resumes the tour at the exact step", async () => {
  await withStudio({
    storage: {
      "living-history.studio.onboarding.progress.v1": JSON.stringify({ status: "active", index: 4 })
    }
  }, async ({ host, tree }) => {
    assert.match(host.innerHTML, /Шаг 5 из 7/);
    assert.ok(tree.validation.classList.contains("lh-tour-highlight"), "resumes onto the validation node");
  });
});

test("FIN-10 Esc closes the dialog and restores focus to the previously focused node", async () => {
  await withStudio({}, async ({ doc, tree, host, trigger }) => {
    tree.board.focus();
    trigger.dispatch("click", {});
    assert.match(host.innerHTML, /Справка Studio/);
    assert.match(host.innerHTML, /Повторить обучение/);
    assert.match(host.innerHTML, /Администратор|линия|Версии|Публикация|автор/i);

    doc.dispatch("keydown", { key: "Escape", preventDefault() {} });
    await Promise.resolve();
    assert.equal(host.innerHTML, "");
    assert.equal(doc.activeElement, tree.board, "focus returns to the node the user was on");
  });
});

test("FIN-10 admin-only step explains the role instead of pointing at an unavailable action", async () => {
  await withStudio({ roleLabel: "Редактор" }, async ({ host }) => {
    for (let i = 0; i < 5; i += 1) clickAction(host, "tour-next");
    assert.match(host.innerHTML, /Шаг 6 из 7/);
    assert.match(host.innerHTML, /недоступен/);
    assert.match(host.innerHTML, /Администратор/);
  });

  await withStudio({ roleLabel: "Владелец" }, async ({ host }) => {
    for (let i = 0; i < 5; i += 1) clickAction(host, "tour-next");
    assert.match(host.innerHTML, /Шаг 6 из 7/);
    assert.doesNotMatch(host.innerHTML, /недоступен/);
  });
});

test("FIN-10 completion keeps a repeat entry point", async () => {
  await withStudio({}, async ({ host }) => {
    for (let i = 0; i < 7; i += 1) clickAction(host, "tour-next");
    assert.match(host.innerHTML, /Обучение завершено/);
    assert.match(host.innerHTML, /Повторить обучение/);
    clickAction(host, "repeat-tour");
    assert.match(host.innerHTML, /Шаг 1 из 7/);
  });
});

test("FIN-10 help follows the live role badge instead of a snapshot at install", async () => {
  await withStudio({ roleLabel: "Редактор" }, async ({ tree, trigger, host }) => {
    trigger.dispatch("click", {});
    assert.doesNotMatch(host.innerHTML, /Публикация выпуска/);
    assert.match(host.innerHTML, /Проверка/);

    tree.roleBadge.textContent = "Владелец";
    trigger.dispatch("click", {}); // повторное открытие перечитывает роль
    assert.match(host.innerHTML, /Публикация выпуска/);
    assert.match(host.innerHTML, /Участники и роли/);
  });
});

test("FIN-10 renderStudioError shows Russian copy with a working retry action", async () => {
  const { renderStudioError } = await import("../dist/src/onboarding.js");
  const container = new FakeElement("div");
  const doc = makeDocument();
  container.ownerDocument = doc;
  let retries = 0;
  const handle = renderStudioError(container, "background-load", () => { retries += 1; });
  const text = handle.element.querySelector(".lh-studio-error-text");
  assert.equal(text.textContent, "Не удалось загрузить фон — повторить");
  const retry = handle.element.querySelector(".lh-studio-error-retry");
  assert.equal(retry.textContent, "Повторить");
  retry.dispatch("click", {});
  assert.equal(retries, 1);
  handle.dispose();
  assert.equal(container.children.length, 0);
});
