/*
 * Кнопка «Настроить подключение» в панели ИИ-помощника ДЕЙСТВИТЕЛЬНО доводит
 * автора до формы подключения провайдера.
 *
 * Страж от регресса: панель (apps/studio/src/ai-panel.ts) отправляла событие
 * ai-panel:configure, но слушателя в продукте не было — нажатие не давало ни
 * изменения DOM, ни запроса. Здесь проверяется живое подключение в приложении,
 * на мини-DOM с настоящим всплытием события, а не модуль сам по себе:
 *
 *  1) в панели внутри приложения есть кнопка data-action="ai-configure";
 *  2) нажатие на неё открывает настоящий блок «Подключение ИИ-помощника»
 *     (.provider-settings с #provider-form) — тот самый, что работает на странице
 *     через provider-settings.ts, — и ставит фокус в первое поле формы;
 *  3) открытие не перерисовывает оболочку и не отправляет ни одного запроса;
 *  4) слушатель ровно один и снимается вместе с приложением (destroy);
 *  5) если блока подключения нет, панель честно объясняет это автору
 *     (data-ai-configure-notice), а не молчит.
 *
 * Запуск (после сборки dist): node --test apps/studio/test/ai-configure-wiring.test.mjs
 * Мутация: убрать из app.ts строку root.addEventListener(AI_PANEL_CONFIGURE_EVENT, ...)
 * (или блок .provider-settings из оболочки) — этот файл краснеет.
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
  /**
   * Всплытие: обработчики вызываются от цели вверх по parentNode. Настоящий
   * CustomEvent передаётся слушателям ТЕМ ЖЕ объектом (иначе preventDefault
   * оболочки не был бы виден панели), а target подставляется как в браузере.
   */
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

let providerDockElement = null;

const documentStub = {
  activeElement: null,
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_ns, tag) => new FakeElement(tag),
  elementFromPoint: () => null,
  querySelector(selector) {
    const text = String(selector);
    if (providerDockElement === null) return null;
    if (text === ".provider-settings") return providerDockElement;
    if (text === "#provider-form") return providerDockElement.querySelector("#provider-form");
    return null;
  },
  querySelectorAll: () => [],
  listeners: new Map(),
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  },
  removeEventListener() {}
};

globalThis.Element = FakeElement;
globalThis.HTMLElement = FakeElement;
globalThis.HTMLFormElement = FakeElement;
globalThis.document = documentStub;
globalThis.window = {
  location: { origin: "http://127.0.0.1", href: "http://127.0.0.1/" },
  setTimeout: (callback) => { if (typeof callback === "function") callback(); return 0; },
  clearTimeout: () => {},
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {}
};
globalThis.EventSource = class { addEventListener() {} close() {} };
globalThis.FormData = class { get() { return null; } getAll() { return []; } };

const requests = [];
globalThis.fetch = async (url) => {
  requests.push(String(url));
  return { ok: false, status: 503, json: async () => null };
};

const { StudioApp } = await import("../dist/src/app.js");
const { AI_PANEL_CONFIGURE_EVENT, AI_CONFIGURE_UNHANDLED, renderAiPanel } = await import("../dist/src/ai-panel.js");

/* ── Фикстуры ────────────────────────────────────────────────────────────── */

const PROJECT_ID = "p";
const QUEST_ID = "q";

function mission() {
  return {
    schemaVersion: "1.0",
    projectId: PROJECT_ID,
    questId: QUEST_ID,
    contentRevision: 1,
    contentHash: "c".repeat(64),
    listing: {},
    story: {
      entrySceneId: "depot",
      scenes: [
        {
          id: "depot",
          title: "Депо",
          text: "Ночь. Мастер ждёт у ворот.",
          dialogue: [],
          choices: [{ id: "c1", label: "На пути", targetSceneId: "tracks", endingId: null, conditions: [], effects: [] }]
        },
        { id: "tracks", title: "Пути", text: "Тупик между вагонами.", dialogue: [], choices: [] }
      ],
      endings: [{ id: "found", title: "Найден", text: "Ящики на месте." }]
    },
    screens: { intros: [], scenes: {}, endings: {} },
    defaults: { background: null, theme: "", animationPreset: "" }
  };
}

function draft() {
  return { projectId: PROJECT_ID, questId: QUEST_ID, draftRevision: 1, title: "Квест", entryLocationId: "yard", contentHash: "x".repeat(64), blocks: [] };
}

/** Блок «Подключение ИИ-помощника» из оболочки Studio (apps/studio/index.html). */
const PROVIDER_DOCK_HTML = `
  <summary>Подключение ИИ-помощника</summary>
  <form id="provider-form">
    <p>Настройка для локальной Studio. Ключ хранится в памяти сервера до отключения или перезапуска. Запросы оплачиваются по тарифу провайдера.</p>
    <label>Провайдер <select name="preset"><option value="openrouter">OpenRouter</option><option value="compatible">Совместимый API</option></select></label>
    <label>Базовый адрес API <input name="baseUrl" type="url" value="https://openrouter.ai/api/v1" required></label>
    <label>Модель <input name="model" placeholder="Идентификатор модели у провайдера" required maxlength="200"></label>
    <label>API-ключ <input name="credential" type="password" autocomplete="off" required maxlength="4096"></label>
    <button type="submit">Сохранить подключение</button>
    <button type="button" id="provider-disconnect">Отключить</button>
    <p id="provider-status" role="status">Проверяем настройки…</p>
  </form>`;

function providerDock() {
  const dock = new FakeElement("details");
  dock.setAttribute("class", "provider-settings");
  dock.open = false;
  dock.innerHTML = PROVIDER_DOCK_HTML;
  return dock;
}

function bootApp({ withDock = true } = {}) {
  providerDockElement = withDock ? providerDock() : null;
  const root = new FakeElement("div");
  const api = {
    async listProjects() { return []; },
    async listQuests() { return []; },
    async listProjectAssets() { return []; }
  };
  const app = new StudioApp(root, api);
  app.state.access = Object.freeze({ mode: "local-owner", auth: null, mutationProof: true, members: null, membersError: null });
  app.state.view = "editor";
  app.state.projects = Object.freeze([{ projectId: PROJECT_ID, title: "Проект", role: "owner" }]);
  app.state.selectedProjectId = PROJECT_ID;
  app.state.selectedQuestId = QUEST_ID;
  app.state.quests = Object.freeze([{ projectId: PROJECT_ID, questId: QUEST_ID, draftRevision: 1, title: "Квест", entryLocationId: "yard", contentHash: "x".repeat(64) }]);
  app.state.draft = draft();
  app.state.mission = mission();
  app.state.missionRevision = 1;
  app.state.boardPositions = new Map();
  // Список, а не доска: тесту нужен только монтаж панели ИИ-помощника,
  // остальные тяжёлые хосты в разметке не рисуются.
  app.state.boardView = "list";
  // Вкладка ИИ-помощника в инспекторе: именно она монтирует панель.
  app.state.inspectorTab = "coauthor";
  app.render();
  return { app, root, dock: providerDockElement };
}

async function settle(times = 6) {
  for (let step = 0; step < times; step += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function configureButton(panelHost) {
  const button = panelHost.querySelector('[data-action="ai-configure"]');
  assert.ok(button, "в панели ИИ-помощника есть кнопка «Настроить подключение»");
  return button;
}

/** Текст узла целиком — включая вложенные элементы, как его читает автор. */
function visibleText(node) {
  let text = node.textContent ?? "";
  for (const child of node.children ?? []) text += ` ${visibleText(child)}`;
  return text;
}

/* ── 1. Кнопка доводит до настоящей формы подключения ────────────────────── */

test("кнопка «Настроить подключение»: нажатие открывает форму подключения провайдера", async () => {
  const { app, root, dock } = bootApp();
  await settle();

  assert.ok(dock, "оболочка отдаёт блок «Подключение ИИ-помощника»");
  assert.equal(dock.open, false, "до нажатия блок подключения закрыт");
  assert.equal(dock.querySelector("#provider-form") !== null, true, "в блоке есть рабочая форма #provider-form");

  const panelHost = root.querySelector("[data-ai-panel-host]");
  assert.ok(panelHost, "панель ИИ-помощника смонтирована в свой хост");
  assert.match(panelHost.innerHTML, /data-ai-unavailable/, "провайдер не настроен — панель просит настроить подключение");
  assert.match(panelHost.innerHTML, /data-ai-unavailable-reason>Подключение к ИИ не настроено/, "причина показана автору");

  const requestsBefore = requests.length;
  configureButton(panelHost).dispatch("click");
  await settle();

  // Форма подключения реально появилась: блок раскрыт, поля на месте, фокус в поле.
  assert.equal(dock.open, true, "блок подключения раскрыт после нажатия");
  assert.equal(dock.scrolledIntoView > 0, true, "блок подключения показан автору (scrollIntoView)");
  const form = dock.querySelector("#provider-form");
  for (const name of ["preset", "baseUrl", "model", "credential"]) {
    assert.ok(form.querySelectorAll(`[name="${name}"]`).length === 1, `поле ${name} видно в форме подключения`);
  }
  const focused = documentStub.activeElement;
  assert.ok(focused && form.querySelectorAll("input, select").includes(focused), "фокус стоит в первом поле формы подключения");
  assert.match(visibleText(form), /Сохранить подключение/, "кнопка сохранения подключения на месте");

  // Ни одного нового запроса и никакой перерисовки панели: открытие блока ничего не срывает.
  assert.equal(requests.length, requestsBefore, "нажатие не отправляет запросов");
  assert.equal(root.querySelector("[data-ai-panel-host]"), panelHost, "панель осталась в том же хосте");
  assert.match(panelHost.innerHTML, /data-ai-unavailable/, "панель не потеряла своё состояние");
  assert.doesNotMatch(panelHost.innerHTML, /data-ai-configure-notice/, "оболочка подтвердила открытие — лишнего объяснения нет");

  // Слушатель ровно один и снимается вместе с приложением.
  assert.equal(root.listenerCount(AI_PANEL_CONFIGURE_EVENT), 1, "ровно один слушатель просьбы открыть подключение");
  app.destroy();
  assert.equal(root.listenerCount(AI_PANEL_CONFIGURE_EVENT), 0, "destroy снимает слушатель");
});

/* ── 2. Повторные нажатия не плодят обработчики и не шлют запросы ────────── */

test("кнопка «Настроить подключение»: три нажатия подряд остаются одним слушателем и нулём запросов", async () => {
  const { root, dock } = bootApp();
  await settle();
  const panelHost = root.querySelector("[data-ai-panel-host]");
  const requestsBefore = requests.length;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    configureButton(panelHost).dispatch("click");
    await settle(2);
  }
  assert.equal(dock.open, true, "блок подключения открыт");
  assert.equal(root.listenerCount(AI_PANEL_CONFIGURE_EVENT), 1, "слушатель не продублировался");
  assert.equal(requests.length, requestsBefore, "повторные нажатия не вызывают запросов");
  assert.doesNotMatch(panelHost.innerHTML, /data-ai-configure-notice/, "панель не показывает ложную тревогу");
});

/* ── 3. Предусловие не выполнено: честное объяснение вместо тишины ───────── */

test("кнопка «Настроить подключение»: без блока подключения в оболочке панель объясняет это автору", async () => {
  const { root } = bootApp({ withDock: false });
  await settle();
  const panelHost = root.querySelector("[data-ai-panel-host]");
  const requestsBefore = requests.length;

  configureButton(panelHost).dispatch("click");
  await settle();

  assert.equal(requests.length, requestsBefore, "неудачное открытие тоже не шлёт запросов");
  assert.match(panelHost.innerHTML, /data-ai-configure-notice/, "автор видит объяснение, а не тишину");
  assert.ok(panelHost.innerHTML.includes(AI_CONFIGURE_UNHANDLED), "текст объяснения — тот же, что объявлен панелью");
  assert.match(panelHost.innerHTML, /Настроить подключение/, "действие повтора осталось на месте");
  assert.match(panelHost.innerHTML, /Проверить снова/, "рядом есть понятное действие");
});

/* ── 4. Панель как модуль: без слушателя она тоже не молчит ──────────────── */

test("панель ИИ-помощника: событие настройки уходит наверх и без слушателя не оставляет тишину", async () => {
  const host = new FakeElement("div");
  const events = [];
  const handle = renderAiPanel({
    root: host,
    async readiness() { return { available: false, reason: null, model: null }; },
    async generate() { throw new Error("не вызывается"); },
    async preview() { return { scenes: [] }; },
    async accept() { return { ok: true, message: "" }; },
    onError() {}
  });
  await settle();
  const original = host.dispatchEvent;
  host.dispatchEvent = function dispatchEvent(event) {
    events.push(event);
    return original.call(this, event);
  };
  configureButton(host).dispatch("click");
  await settle();

  assert.equal(events.length, 1, "панель отправляет ровно одно событие настройки подключения");
  assert.equal(events[0].type, AI_PANEL_CONFIGURE_EVENT);
  assert.equal(events[0].bubbles, true, "событие всплывает — оболочка может его поймать");
  assert.equal(events[0].cancelable, true, "оболочка может подтвердить открытие формы");
  assert.match(host.innerHTML, /data-ai-configure-notice/, "слушателя нет — панель честно объясняет это");
  handle();
});
