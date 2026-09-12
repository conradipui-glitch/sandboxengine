/*
 * Проводка блока «Подключение ИИ-помощника»: настоящая разметка страницы
 * (apps/studio/index.html) + настоящий скрипт страницы
 * (dist/src/provider-settings.js) + контроллер формы.
 *
 * Страж ловит именно то, что ломалось живьём: поле ключа больше не required,
 * кнопки «Проверить подключение» и «Получить список моделей» действительно
 * ходят на сервер и показывают результат, окно закрывается кнопкой и Escape,
 * а в форме видно, ЧТО сохранено (ключ — только маской).
 *
 * DOM подставной (jsdom в репозитории нет), но разметка берётся из настоящего
 * index.html, а поведение — из собранного модуля.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(HERE, "..", "index.html");

/* ── Разбор настоящего блока подключения из index.html ──────────────────── */

function providerDockMarkup() {
  const html = readFileSync(INDEX_HTML, "utf8");
  const start = html.indexOf('<details class="provider-settings">');
  assert.ok(start >= 0, "в index.html есть блок .provider-settings");
  const end = html.indexOf("</details>", start);
  assert.ok(end > start, "блок .provider-settings закрыт");
  return html.slice(start, end + "</details>".length);
}

/* ── Мини-DOM: ровно те возможности, что нужны скрипту страницы ─────────── */

const VOID_TAGS = new Set(["input", "br", "hr", "meta", "link", "img", "source"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };

function decode(text) {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_m, name) => ENTITIES[name]);
}

class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.listeners = new Map();
    this.style = {};
    this.value = "";
    this.readOnly = false;
    this.open = false;
    this.hidden = false;
    this.focused = false;
    this._text = "";
    this._html = "";
  }
  get className() { return this.attrs.class ?? ""; }
  get parentElement() { return this.parentNode; }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); }
  removeAttribute(name) { delete this.attrs[name]; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this._text = String(value); this.children = []; this._html = ""; }
  get innerHTML() { return this._html; }
  set innerHTML(value) { this._html = String(value); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]); }
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== handler));
  }
  listenerCount(type) { return (this.listeners.get(type) ?? []).length; }
  dispatch(type, event = {}) {
    const effective = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...event };
    if (effective.target === undefined) effective.target = this;
    let node = this;
    while (node) {
      for (const handler of [...(node.listeners.get(type) ?? [])]) handler(effective);
      node = node.parentNode;
    }
    return effective;
  }
  dispatchEvent(event) { return this.dispatch(event.type, event); }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolledIntoView = true; }
  matches(selector) {
    return String(selector).split(",").some((part) => matchesSimple(this, part.trim()));
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches?.(selector)) return node;
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
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  get elements() {
    const named = this.querySelectorAll("[name]");
    return {
      namedItem: (name) => named.find((element) => element.getAttribute("name") === name) ?? null,
      length: named.length,
      [Symbol.iterator]: () => named[Symbol.iterator]()
    };
  }
}

function matchesSimple(element, selector) {
  const text = String(selector).trim();
  if (text === "") return false;
  const tagMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(text);
  let rest = text;
  if (tagMatch) {
    if (element.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
    rest = text.slice(tagMatch[1].length);
  }
  let consumed = 0;
  const partRe = /(?:#([-a-zA-Z0-9_]+))|(?:\.([-a-zA-Z0-9_]+))|(?:\[([-a-zA-Z0-9_]+)(?:=["']([^"']*)["'])?\])/g;
  let match;
  while ((match = partRe.exec(rest)) !== null) {
    if (match.index !== consumed) return false;
    consumed = partRe.lastIndex;
    if (match[1] !== undefined) {
      if (element.getAttribute("id") !== match[1]) return false;
    } else if (match[2] !== undefined) {
      if (!element.className.split(/\s+/).includes(match[2])) return false;
    } else {
      if (match[3] === "data-action" && element.getAttribute("data-action") === null) return false;
      if (!element.hasAttribute(match[3])) return false;
      if (match[4] !== undefined && element.getAttribute(match[3]) !== match[4]) return false;
    }
  }
  if (tagMatch && rest.length > 0 && consumed !== rest.length) return false;
  return consumed > 0 || tagMatch !== null;
}

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:=["']([^"']*)["'])?/g;

/** Разбор разметки блока в мини-DOM: только теги, атрибуты и текст. */
function parseMarkup(html) {
  const root = new Node("div");
  const stack = [root];
  let index = 0;
  while (index < html.length) {
    if (html[index] !== "<") {
      const next = html.indexOf("<", index);
      const end = next === -1 ? html.length : next;
      stack[stack.length - 1]._text += decode(html.slice(index, end));
      index = end;
      continue;
    }
    const close = html.indexOf(">", index);
    assert.ok(close > 0, `незакрытый тег: ${html.slice(index, index + 50)}`);
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
    const element = new Node(tag);
    ATTR_RE.lastIndex = 0;
    let attribute;
    while ((attribute = ATTR_RE.exec(attrText)) !== null) {
      element.setAttribute(attribute[1], attribute[2] === undefined ? "" : decode(attribute[2]));
      if (attribute[1] === "open") element.open = true;
    }
    if (element.hasAttribute("value")) element.value = element.getAttribute("value");
    stack[stack.length - 1].appendChild(element);
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(element);
  }
  // Значения select/checkbox — как их читает скрипт страницы.
  for (const select of root.querySelectorAll("select")) {
    const options = select.querySelectorAll("option");
    const selected = options.find((option) => option.hasAttribute("selected")) ?? options[0];
    if (selected) select.value = selected.getAttribute("value") ?? selected.textContent.trim();
  }
  return root;
}

/* ── Загрузка страницы с подставной сетью ──────────────────────────────── */

function bootPage(routes) {
  const markup = providerDockMarkup();
  const root = parseMarkup(markup);
  const dock = root;
  dock.setAttribute("class", "provider-settings");
  const documentListeners = new Map();
  const calls = [];

  const documentStub = {
    querySelector(selector) {
      const text = String(selector);
      if (text === ".provider-settings") return dock;
      return root.querySelector(text);
    },
    querySelectorAll: () => [],
    addEventListener(type, handler) {
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), handler]);
    },
    removeEventListener() {}
  };
  globalThis.document = documentStub;

  globalThis.fetch = async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url: String(url), method, body: init?.body ?? null, headers: init?.headers ?? null });
    const key = `${method} ${url}`;
    const route = routes[key] ?? routes[String(url)] ?? routes["*"];
    if (route === undefined) throw new Error(`нет маршрута для ${key}`);
    return { ok: route.ok !== false, status: route.status ?? 200, json: async () => route.body };
  };

  return { root, dock, calls, documentStub, fireDocument: (type, event) => {
    for (const handler of [...(documentListeners.get(type) ?? [])]) handler(event);
  } };
}

const SESSION_LOCAL = "GET /control/v1/auth/session";

const SAVED_STATUS = Object.freeze({
  configured: true,
  state: "settings_saved",
  settings: { preset: "compatible", baseUrl: "https://api.example/v1", model: "model-1" },
  hasCredential: true,
  credentialMask: "sk-…cdef",
  lastErrorCode: null,
  probeCause: null,
  probeLatencyMs: null,
  probeHttpStatus: null
});

const settle = async (times = 8) => {
  for (let step = 0; step < times; step += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

async function loadPage(routes) {
  const page = bootPage(routes);
  // Свежий импорт на каждый тест: модуль читает document при загрузке.
  await import(`../dist/src/provider-settings.js?probe=${Math.random()}`);
  await settle(12);
  return page;
}

/* ── Проверки ──────────────────────────────────────────────────────────── */

test("подключение ИИ: разметка страницы не требует ключ заново и даёт нужные действия", () => {
  const markup = providerDockMarkup();
  assert.doesNotMatch(markup, /name="credential"[^>]*required/, "поле ключа не должно быть обязательным");
  assert.doesNotMatch(markup, /name="model"[^>]*required/);
  for (const action of ["provider-probe", "provider-models", "provider-close", "provider-disconnect"]) {
    assert.match(markup, new RegExp(`data-action="${action}"`), `в блоке есть действие ${action}`);
  }
  for (const id of ["provider-status", "provider-credential-state", "provider-saved", "provider-models", "provider-form"]) {
    assert.ok(markup.includes(`id="${id}"`), `в блоке есть элемент #${id}`);
  }
  for (const name of ["preset", "baseUrl", "model", "credential"]) {
    assert.equal(markup.split(`name="${name}"`).length - 1, 1, `поле ${name} ровно одно`);
  }
});

test("подключение ИИ: страница показывает сохранённое подключение и маску ключа", async () => {
  const page = await loadPage({ [SESSION_LOCAL]: { status: 404 }, "GET /local/author-provider": { body: SAVED_STATUS } });

  const status = page.root.querySelector("#provider-status");
  assert.match(status.textContent, /Настройки сохранены/);
  assert.match(status.textContent, /Проверить подключение/, "подсказка ведёт к проверке");
  assert.match(page.root.querySelector("#provider-credential-state").textContent, /Ключ сохранён: sk-…cdef/);

  const saved = page.root.querySelector("#provider-saved").innerHTML;
  assert.match(saved, /Совместимый API/);
  assert.match(saved, /https:\/\/api\.example\/v1/);
  assert.match(saved, /модель model-1/);
  assert.match(saved, /sk-…cdef/);
  assert.match(saved, /data-action="provider-apply"/);
  assert.match(saved, /data-action="provider-forget"/);

  const form = page.root.querySelector("#provider-form");
  assert.equal(form.elements.namedItem("model").value, "model-1", "поле модели заполнено сохранённым значением");
  assert.equal(form.elements.namedItem("credential").value, "", "поле ключа пустое: ключ не показывается");
  assert.equal(form.elements.namedItem("credential").getAttribute("required"), null);
});

test("подключение ИИ: «Проверить подключение» отвечает причиной, а не тайм-аутом", async () => {
  const slow = { ...SAVED_STATUS, state: "error", probeCause: "slow_timeout", probeLatencyMs: 10_000, lastErrorCode: "timeout" };
  const page = await loadPage({
    [SESSION_LOCAL]: { status: 404 },
    "GET /local/author-provider": { body: SAVED_STATUS },
    "POST /local/author-provider/probe": { body: slow }
  });

  const form = page.root.querySelector("#provider-form");
  const probeButton = form.querySelector('[data-action="provider-probe"]');
  probeButton.dispatch("click", { target: probeButton });
  await settle(10);

  const probeCall = page.calls.find((call) => call.url.endsWith("/probe"));
  assert.ok(probeCall, "нажатие действительно отправило запрос проверки");
  assert.equal(probeCall.headers["x-lh-local-settings"], "1");
  const status = page.root.querySelector("#provider-status").textContent;
  assert.match(status, /не удалась/);
  assert.match(status, /не ответил за отведённое время/);
  assert.match(status, /ответ за 10000 мс/);
});

test("подключение ИИ: «Получить список моделей» показывает модели провайдера", async () => {
  const page = await loadPage({
    [SESSION_LOCAL]: { status: 404 },
    "GET /local/author-provider": { body: SAVED_STATUS },
    "POST /local/author-provider/models": {
      body: { kind: "ok", cause: "connected", models: [{ id: "qwen/qwen3-32b", name: "Qwen3 32B" }], latencyMs: 20, httpStatus: 200, truncated: false }
    }
  });
  const form = page.root.querySelector("#provider-form");
  const modelsButton = form.querySelector('[data-action="provider-models"]');
  modelsButton.dispatch("click", { target: modelsButton });
  await settle(10);
  const html = page.root.querySelector("#provider-models").innerHTML;
  assert.match(html, /Модели провайдера \(1\)/);
  assert.match(html, /Qwen3 32B/);
  assert.match(html, /data-action="provider-use-model" data-model-id="qwen\/qwen3-32b"/);
});

test("подключение ИИ: окно закрывается кнопкой «Закрыть» и клавишей Escape", async () => {
  const page = await loadPage({ [SESSION_LOCAL]: { status: 404 }, "GET /local/author-provider": { body: SAVED_STATUS } });
  const form = page.root.querySelector("#provider-form");
  assert.equal(page.dock.open, false, "до нажатия блок может быть закрыт");

  page.dock.open = true;
  const closeButton = form.querySelector('[data-action="provider-close"]');
  closeButton.dispatch("click", { target: closeButton });
  assert.equal(page.dock.open, false, "кнопка «Закрыть» закрывает окно");

  page.dock.open = true;
  page.fireDocument("keydown", { key: "Escape", preventDefault() {} });
  assert.equal(page.dock.open, false, "Escape закрывает окно");
});

test("подключение ИИ: сохранение без ключа оставляет прежний ключ и показывает результат", async () => {
  const page = await loadPage({
    [SESSION_LOCAL]: { status: 404 },
    "GET /local/author-provider": { body: SAVED_STATUS },
    "POST /local/author-provider": { body: { ...SAVED_STATUS, model: "model-2", event: "saved" } }
  });
  const form = page.root.querySelector("#provider-form");
  form.elements.namedItem("model").value = "model-2";
  form.dispatch("submit", {});
  await settle(10);
  const post = page.calls.find((call) => call.method === "POST");
  assert.ok(post, "форма отправила сохранение");
  assert.deepEqual(JSON.parse(post.body), { preset: "compatible", baseUrl: "https://api.example/v1", model: "model-2", credential: "" });
  assert.match(page.root.querySelector("#provider-status").textContent, /Подключение сохранено/);
  assert.equal(form.elements.namedItem("credential").value, "");
});
