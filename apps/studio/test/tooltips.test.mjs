/*
 * Единый механизм подсказок-облачков Studio (src/tooltip.ts + styles/tooltip.css).
 *
 * Дефект приёмки: автор не понимает, что делают элементы интерфейса. Проверяется
 * не «модуль существует», а поведение:
 *
 *   1) ПОЯВЛЕНИЕ при наведении указателя и при фокусе с клавиатуры;
 *   2) ЗАКРЫТИЕ по Escape (а также при уходе указателя и смене фокуса);
 *   3) БЕЗ ПЕРЕКРЫТИЯ: облачко не пересекает прямоугольник своего элемента —
 *      над ним, а если сверху нет места, то под ним;
 *   4) ДОСТУПНОСТЬ: aria-describedby ведёт на существующий узел описания с тем
 *      же текстом; атрибут title подсказкой НЕ подменяется;
 *   5) ТЕМЫ: styles/tooltip.css не содержит литеральных цветов — только токены,
 *      объявленные во всех трёх темах;
 *   6) БЕЗ ОБРЕЗКИ: перенос строк, никакого text-overflow: ellipsis и clamp;
 *   7) НАПОЛНЕНИЕ: ключевые элементы Studio несут тексты (добавление карточки
 *      каждого типа, «Создать миссию», три режима, публикация/проверка,
 *      «Технические данные», тур), и каждая ссылка data-tooltip существует в
 *      словаре;
 *   8) ЖИВОЙ ПРОВОД: настоящий app.ts после перерисовки действительно проводит
 *      описания и показывает облачко на реальной разметке.
 *
 * Мутации, на которых файл обязан краснеть: убрать aria-describedby, убрать
 * закрытие по Escape, вернуть позиционирование без зазора (перекрытие),
 * заменить текст на многоточие, добавить в CSS литеральный цвет.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/* ── Мини-DOM: события всплывают по-настоящему ───────────────────────────── */

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
    // Размеры по умолчанию — нулевые: неизмеренный элемент получает размер
    // подстановки самого механизма, как это бывает до первой раскладки.
    this._rect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  }
  focus() {
    documentStub.activeElement = this;
  }
  scrollIntoView() {
    /* прокрутка в тесте не нужна */
  }
  get classList() {
    return new FakeClassList(this);
  }
  get parentElement() {
    return this.parentNode;
  }
  set rect(value) {
    this._rect = value;
  }
  get innerHTML() {
    return "";
  }
  set innerHTML(value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    const parsed = parseMarkup(String(value));
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
    if (name.startsWith("data-")) delete this.dataset[datasetKey(name)];
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
    this.parentNode?.removeChild(this);
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) { this.children.splice(index, 1); child.parentNode = null; }
    return child;
  }
  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== handler));
  }
  /** Всплытие: обработчики вызываются от цели вверх по parentNode. */
  dispatch(type, event = {}) {
    const effective = { preventDefault() {}, stopPropagation() {}, ...event };
    effective.type = type;
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
  getBoundingClientRect() {
    return this._rect;
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
    }
    stack[stack.length - 1].appendChild(element);
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(element);
  }
  return container;
}

function makeDocument() {
  const doc = {
    activeElement: null,
    head: new FakeElement("head"),
    body: new FakeElement("body"),
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
  return doc;
}

const TOOLTIP_MODULE = await import("../dist/src/tooltip.js");
const {
  TOOLTIP_TEXTS,
  TOOLTIP_KEYS,
  TOOLTIP_ATTRIBUTE,
  TOOLTIP_BUBBLE_CLASS,
  TOOLTIP_DESC_CLASS,
  TOOLTIP_VISIBLE_ATTR,
  positionTooltip,
  tooltipOverlapsTarget,
  tooltipText,
  installTooltips
} = TOOLTIP_MODULE;

const STUDIO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP_PATH = `${STUDIO_ROOT}src/app.ts`.replace(/\\/g, "/");
const CSS_PATH = `${STUDIO_ROOT}styles/tooltip.css`.replace(/\\/g, "/");
const ROOT_CSS_PATH = `${STUDIO_ROOT}styles.css`.replace(/\\/g, "/");
const INDEX_PATH = `${STUDIO_ROOT}index.html`.replace(/\\/g, "/");

const appSource = await readFile(APP_PATH, "utf8");
const cssSource = await readFile(CSS_PATH, "utf8");
const rootCssSource = await readFile(ROOT_CSS_PATH, "utf8");
const indexSource = await readFile(INDEX_PATH, "utf8");

/* ── Стенд: корень приложения с элементами, несущими подсказки ───────────── */

function stand({ delayMs = 0 } = {}) {
  const doc = makeDocument();
  const root = new FakeElement("div");
  doc.body.appendChild(root);
  const layer = installTooltips(root, { document: doc, delayMs });
  return { doc, root, layer };
}

function target(label, textKey, rect) {
  const element = new FakeElement("button");
  element.textContent = label;
  element.setAttribute(TOOLTIP_ATTRIBUTE, textKey);
  if (rect) element.rect = rect;
  return element;
}

/* ── 1. Появление: наведение и фокус с клавиатуры ────────────────────────── */

test("подсказка появляется при наведении указателя и содержит текст словаря", () => {
  const { root, layer, doc } = stand();
  const button = target("Место", "add-location");
  root.appendChild(button);

  assert.equal(layer.visible, false, "до наведения подсказки нет");
  button.dispatch("pointerover", { relatedTarget: null });

  assert.equal(layer.visible, true, "после наведения облачко видно");
  assert.equal(layer.text, TOOLTIP_TEXTS["add-location"]);
  const bubble = doc.body.querySelector(`.${TOOLTIP_BUBBLE_CLASS}`);
  assert.ok(bubble, "облачко действительно в DOM");
  assert.equal(bubble.getAttribute(TOOLTIP_VISIBLE_ATTR), "true");
});

test("подсказка появляется при фокусе с клавиатуры (focusin) — без задержки", () => {
  const { root, layer } = stand({ delayMs: 5000 });
  const button = target("Доска", "view-board");
  root.appendChild(button);

  button.dispatch("focusin", {});
  assert.equal(layer.visible, true, "фокус показывает подсказку сразу, а не через задержку");
  assert.equal(layer.text, TOOLTIP_TEXTS["view-board"]);
});

test("наведение сначала не торопит автора: облачко ждёт задержку, таймер снимается Escape", async () => {
  const { root, layer } = stand({ delayMs: 60 });
  const button = target("Сюжет", "view-story");
  root.appendChild(button);

  button.dispatch("pointerover", { relatedTarget: null });
  assert.equal(layer.visible, false, "при наведении показ отложен");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(layer.visible, true, "через задержку облачко появилось");

  root.dispatch("keydown", { key: "Escape" });
  assert.equal(layer.visible, false, "Escape закрывает уже показанное облачко");
});

/* ── 2. Закрытие ─────────────────────────────────────────────────────────── */

test("Escape закрывает подсказку, не трогая остальной интерфейс", () => {
  const { root, layer } = stand();
  const button = target("Тур по Studio", "tour");
  root.appendChild(button);
  button.dispatch("focusin", {});
  assert.equal(layer.visible, true);

  root.dispatch("keydown", { key: "Escape" });
  assert.equal(layer.visible, false, "Escape закрыл облачко");
  assert.equal(layer.text, null, "текста в облачке больше нет");

  root.dispatch("keydown", { key: "Enter" });
  assert.equal(layer.visible, false, "другие клавиши подсказку не показывают");
});

test("подсказка закрывается при уходе указателя и при потере фокуса", () => {
  const { root, layer } = stand();
  const button = target("Публикация", "publish");
  root.appendChild(button);

  button.dispatch("pointerover", { relatedTarget: null });
  assert.equal(layer.visible, true);
  button.dispatch("pointerout", { relatedTarget: null });
  assert.equal(layer.visible, false, "уход указателя закрывает облачко");

  button.dispatch("focusin", {});
  assert.equal(layer.visible, true);
  button.dispatch("focusout", { relatedTarget: null });
  assert.equal(layer.visible, false, "потеря фокуса закрывает облачко");
});

test("подсказка не показывается для неизвестного ключа — пустого облачка не бывает", () => {
  const { root, layer, doc } = stand();
  const button = target("Загадка", "нет-такого-ключа");
  root.appendChild(button);
  button.dispatch("pointerover", { relatedTarget: null });
  assert.equal(layer.visible, false);
  assert.equal(doc.body.querySelector(`.${TOOLTIP_BUBBLE_CLASS}[${TOOLTIP_VISIBLE_ATTR}="true"]`), null);
});

test("прокрутка убирает облачко: старые координаты не накрывают чужое содержимое", () => {
  const { root, layer } = stand();
  const button = target("Технические данные", "technical-data");
  root.appendChild(button);
  button.dispatch("focusin", {});
  assert.equal(layer.visible, true);

  // В браузере это фаза перехвата (attach), в стенде — подъём по родителям.
  button.dispatch("scroll", {});
  assert.equal(layer.visible, false, "после прокрутки облачко скрыто, а не висит над чужой строкой");

  button.dispatch("focusin", {});
  assert.equal(layer.visible, true, "подсказка встаёт заново на новое место");
});

/* ── 3. Без перекрытия содержимого ───────────────────────────────────────── */

test("облачко встаёт над элементом и не пересекает его", () => {
  const { root, layer, doc } = stand();
  const rect = { left: 400, top: 300, width: 120, height: 40, right: 520, bottom: 340 };
  const button = target("Ресурс", "add-resource", rect);
  root.appendChild(button);
  button.dispatch("focusin", {});

  const bubble = doc.body.querySelector(`.${TOOLTIP_BUBBLE_CLASS}`);
  assert.equal(bubble.getAttribute("data-placement"), "top");
  const top = Number.parseFloat(bubble.style.top);
  const left = Number.parseFloat(bubble.style.left);
  // Неизмеренное облачко берёт подстановочную высоту механизма (44px).
  assert.ok(top + 44 <= rect.top, "облачко целиком выше своего элемента");
  assert.ok(left >= 8, "облачко не выходит за левый край окна");

  // Тот же случай через чистую функцию: пересечения с элементом нет.
  const box = positionTooltip(rect, { width: 320, height: 44 }, { width: 1024, height: 768 });
  assert.equal(box.placement, "top");
  assert.equal(tooltipOverlapsTarget(box, rect), false, "ни одного пикселя поверх содержимого");
});

test("positionTooltip: переворот вниз у верхнего края, прижатие к границам окна", () => {
  const viewport = { width: 1000, height: 800 };
  const bubble = { width: 300, height: 50 };

  const high = positionTooltip({ left: 100, top: 600, right: 260, width: 160, height: 40, bottom: 640 }, bubble, viewport);
  assert.equal(high.placement, "top");
  assert.equal(tooltipOverlapsTarget({ ...high }, { left: 100, top: 600, right: 260, width: 160, height: 40, bottom: 640 }), false);

  const nearTop = positionTooltip({ left: 100, top: 4, right: 260, width: 160, height: 40, bottom: 44 }, bubble, viewport);
  assert.equal(nearTop.placement, "bottom", "сверху нет места — облачко уходит под элемент");
  assert.ok(nearTop.top >= 44, "облачко ниже элемента");

  const leftEdge = positionTooltip({ left: 0, top: 500, right: 40, width: 40, height: 40, bottom: 540 }, bubble, viewport);
  assert.ok(leftEdge.left >= 8, "облачко не выходит за левый край");
  const rightEdge = positionTooltip({ left: 970, top: 500, right: 1000, width: 30, height: 40, bottom: 540 }, bubble, viewport);
  assert.ok(rightEdge.left + rightEdge.width <= 992, "облачко не выходит за правый край");
  assert.ok(rightEdge.maxWidth >= 160, "тексту оставлена читаемая ширина");
});

test("любой показанный текст остаётся читаемым: ширина не сжимается до нуля на узком окне", () => {
  const box = positionTooltip(
    { left: 10, top: 300, right: 60, width: 50, height: 30, bottom: 330 },
    { width: 400, height: 60 },
    { width: 320, height: 600 }
  );
  assert.ok(box.maxWidth >= 160, "ширина текста не схлопывается");
  assert.ok(box.left >= 0 && box.left + box.width <= 320, "облачко помещается в окно");
});

/* ── 4. Доступность: aria-describedby, role=tooltip, без title ───────────── */

test("sync подключает aria-describedby на скрытый узел с тем же текстом", () => {
  const { root, layer, doc } = stand();
  const button = target("Персонаж", "add-character");
  root.appendChild(button);

  const wired = layer.sync(root);
  assert.equal(wired, 1, "один элемент с подсказкой — одно описание");

  const describedBy = button.getAttribute("aria-describedby");
  assert.ok(describedBy, "у элемента есть aria-describedby");
  const description = doc.body.querySelector(`.${TOOLTIP_DESC_CLASS}[id="${describedBy}"]`);
  assert.ok(description, "описание существует в документе");
  assert.equal(description.textContent, TOOLTIP_TEXTS["add-character"], "описание содержит тот же текст подсказки");
  assert.equal(description.className, TOOLTIP_DESC_CLASS);
});

test("подсказка не подменяет атрибут title: смысл живёт в aria-describedby", () => {
  const { root, layer, doc } = stand();
  const button = target("Проверить миссию", "validate-mission");
  root.appendChild(button);
  button.dispatch("focusin", {});

  assert.equal(button.getAttribute("title"), null, "title не используется как подсказка");
  const describedBy = button.getAttribute("aria-describedby");
  assert.ok(describedBy, "описание подключено");
  const description = doc.body.querySelector(`.${TOOLTIP_DESC_CLASS}[id="${describedBy}"]`);
  assert.equal(description.textContent, TOOLTIP_TEXTS["validate-mission"]);
  const bubble = doc.body.querySelector(`.${TOOLTIP_BUBBLE_CLASS}`);
  assert.equal(bubble.getAttribute("role"), "tooltip", "облачко носит роль tooltip");
});

test("чужое aria-describedby не затирается при проводке", () => {
  const { root, layer, doc } = stand();
  const button = target("Опубликовать", "publish");
  button.setAttribute("aria-describedby", "publish-why");
  root.appendChild(button);
  layer.sync(root);

  const value = button.getAttribute("aria-describedby");
  assert.ok(value.startsWith("publish-why "), "статическое описание панели сохраняется");
  assert.ok(doc.body.querySelector(`.${TOOLTIP_DESC_CLASS}[id="${value.split(" ")[1]}"]`), "и своё описание добавлено");
});

test("повторная проводка после перерисовки не оставляет старых описаний", () => {
  const { root, layer, doc } = stand();
  const first = target("Место", "add-location");
  root.appendChild(first);
  layer.sync(root);
  const firstId = first.getAttribute("aria-describedby");

  // Перерисовка: старый узел ушёл, разметка создана заново.
  root.innerHTML = "<button data-tooltip=\"add-location\">Место</button>";
  layer.sync(root);

  assert.equal(doc.body.querySelector(`[id="${firstId}"]`), null, "старое описание убрано");
  const fresh = root.querySelector("[data-tooltip]");
  const freshId = fresh.getAttribute("aria-describedby");
  assert.ok(freshId && doc.body.querySelector(`.${TOOLTIP_DESC_CLASS}[id="${freshId}"]`), "новому элементу подключено свежее описание");
  assert.equal(doc.body.querySelectorAll(`.${TOOLTIP_DESC_CLASS}`).length, 1, "дубликатов описаний нет");
});

test("destroy снимает слушатели и узлы слоя", () => {
  const { root, layer, doc } = stand();
  const button = target("Тур по Studio", "tour");
  root.appendChild(button);
  layer.sync(root);
  button.dispatch("focusin", {});
  assert.equal(layer.visible, true);

  layer.destroy();
  assert.equal(layer.visible, false);
  assert.equal(doc.body.querySelector(`.${TOOLTIP_BUBBLE_CLASS}`), null, "облачко убрано из документа");
  assert.equal(doc.body.querySelectorAll(`.${TOOLTIP_DESC_CLASS}`).length, 0, "описания убраны");
});

/* ── 5. Темы ─────────────────────────────────────────────────────────────── */

function themeTokenNames(css) {
  const names = new Set();
  for (const [, name] of css.matchAll(/--([a-z0-9-]+)\s*:/gi)) names.add(name);
  return names;
}

test("styles/tooltip.css берёт цвета только из токенов тем, а не из литералов", () => {
  assert.doesNotMatch(cssSource, /#[0-9a-f]{3,8}\b/i, "в подсказках нет литеральных hex-цветов");
  assert.doesNotMatch(cssSource, /\b(?:rgb|rgba|hsl|hsla)\s*\(/i, "нет литеральных rgb()/hsl()");
  assert.match(cssSource, /var\(--(?:surface|surface-soft|canvas)\)/, "поверхность облачка — токен темы");
  assert.match(cssSource, /var\(--text\)/, "цвет текста — токен темы");
  assert.match(cssSource, /var\(--border-strong\)/, "граница — токен темы");
});

test("все токены подсказок объявлены во ВСЕХ трёх темах (тёмная, светлая, графит)", async () => {
  const themeStyles = await readFile(fileURLToPath(new URL("../src/theme-palettes.ts", import.meta.url)), "utf8");
  const used = new Set(
    [...cssSource.matchAll(/var\(--([a-z0-9-]+)(?:,[^)]*)?\)/gi)].map((match) => match[1])
  );
  assert.ok(used.size > 0, "подсказки используют токены");
  const declared = themeTokenNames(rootCssSource);
  for (const name of used) {
    assert.ok(declared.has(name), `токен --${name} не объявлен ни в одной теме`);
    assert.ok(themeStyles.includes(`"${name}"`), `токен --${name} не описан в theme-palettes.ts (единый источник тем)`);
  }
  // Три набора значений: тёмная (в т.ч. :root), светлая, графит.
  const blocks = rootCssSource.match(/:(?:root(?:\[data-theme="(?:dark|light|graphite)"\])?)\s*\{/g) ?? [];
  assert.ok(blocks.length >= 3, "в styles.css объявлены наборы значений тем");
});

/* ── 6. Без обрезки текста ───────────────────────────────────────────────── */

test("styles/tooltip.css переносит текст и не обрезает его многоточием", () => {
  assert.doesNotMatch(cssSource, /text-overflow\s*:\s*ellipsis/i, "обрезка многоточием запрещена");
  assert.doesNotMatch(cssSource, /-webkit-line-clamp\s*:/i, "line-clamp — та же обрезка");
  assert.doesNotMatch(cssSource, /(?<![-\w])line-clamp\s*:/i, "line-clamp — та же обрезка");
  assert.doesNotMatch(cssSource, /white-space\s*:\s*nowrap/i, "запрет переноса — это обрезка");
  assert.match(cssSource, /white-space\s*:\s*normal/, "текст подсказки переносится по строкам");
  assert.match(cssSource, /overflow-wrap\s*:\s*anywhere/, "длинные слова переносятся, а не вылезают");
  // Облачко не перехватывает указатель: под ним интерфейс остаётся доступным.
  assert.match(cssSource, /pointer-events\s*:\s*none/);
});

test("ни один текст подсказки не обрезан многоточием и объясняет действие целым предложением", () => {
  for (const key of TOOLTIP_KEYS) {
    const text = TOOLTIP_TEXTS[key];
    assert.ok(typeof text === "string" && text.trim().length >= 40, `текст «${key}» слишком короткий, чтобы объяснить действие`);
    assert.doesNotMatch(text, /…|\.\.\.$/, `текст «${key}» заканчивается обрезкой-многоточием`);
    assert.match(text, /[.!]$/, `текст «${key}» — законченное предложение`);
  }
});

/* ── 7. Наполнение ключевых элементов Studio ─────────────────────────────── */

const REQUIRED_KEYS = [
  "add-location",
  "add-character",
  "add-resource",
  "add-action",
  "create-quest",
  "view-board",
  "view-list",
  "view-story",
  "validate-mission",
  "play-quest",
  "publish",
  "technical-data",
  "tour"
];

test("словарь покрывает ключевые элементы Studio из карточки задачи", () => {
  for (const key of REQUIRED_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(TOOLTIP_TEXTS, key), `в словаре нет текста «${key}»`);
    assert.equal(tooltipText(key), TOOLTIP_TEXTS[key]);
  }
  assert.equal(tooltipText("nope"), null, "незнакомый ключ — не текст");
  assert.equal(tooltipText(null), null);
  assert.equal(tooltipText(""), null);
});

test("каждая ссылка data-tooltip в app.ts указывает на существующий текст", () => {
  const keys = [...appSource.matchAll(/data-tooltip="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(keys.length >= REQUIRED_KEYS.length, "разметка несёт подсказки на ключевые элементы");
  for (const key of keys) {
    assert.ok(Object.prototype.hasOwnProperty.call(TOOLTIP_TEXTS, key), `app.ts ссылается на несуществующий текст «${key}»`);
  }
});

test("app.ts наполняет подсказками именно ключевые элементы", () => {
  const expected = [
    /data-action="add-block"\s+data-block-kind="location"\s+data-tooltip="add-location"/,
    /data-action="add-block"\s+data-block-kind="character"\s+data-tooltip="add-character"/,
    /data-action="add-block"\s+data-block-kind="resource"\s+data-tooltip="add-resource"/,
    /data-action="add-block"\s+data-block-kind="action"\s+data-tooltip="add-action"/,
    /data-tooltip="create-quest"/,
    /data-action="board-view"\s+data-view="board"\s+data-tooltip="view-board"/,
    /data-action="board-view"\s+data-view="list"\s+data-tooltip="view-list"/,
    /data-action="board-view"\s+data-view="story"\s+data-tooltip="view-story"/,
    /data-action="validate"\s+data-tooltip="validate-mission"/,
    /data-action="play-quest"\s+data-tooltip="play-quest"/,
    /data-panel="publish"\s+role="menuitem"\s+data-tooltip="publish"/,
    /<summary data-tooltip="technical-data">/,
    /data-action="start-tour"\s+data-tooltip="tour"/
  ];
  for (const pattern of expected) {
    assert.match(appSource, pattern, `разметка не содержит подсказки: ${pattern}`);
  }
  assert.ok(appSource.includes("installTooltips(this.root)"), "app.ts действительно подключает механизм");
  assert.ok(appSource.includes("this.tooltips.sync(this.root)"), "после перерисовки описания проводятся заново");
  assert.ok(appSource.includes("this.tooltips.destroy()"), "при закрытии мастерской слушатели снимаются");
});

test("лист подсказок подключён в оболочке Studio", () => {
  assert.match(indexSource, /\/studio-assets\/styles\/tooltip\.css/, "index.html подключает styles/tooltip.css");
});

/* ── 8. Живой провод: настоящий app.ts на настоящей разметке ─────────────── */

const documentStub = makeDocument();
const storage = new Map();

globalThis.Element = FakeElement;
globalThis.HTMLElement = FakeElement;
globalThis.HTMLFormElement = FakeElement;
globalThis.document = documentStub;
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); }
};
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

const PROJECT_ID = "p-tooltips";
const QUEST_ID = "q-tooltips";

function draftFixture() {
  return {
    projectId: PROJECT_ID,
    questId: QUEST_ID,
    draftRevision: 1,
    title: "Ночная смена",
    entryLocationId: "yard",
    contentHash: "x".repeat(64),
    blocks: Object.freeze([])
  };
}

function bootApp() {
  const root = new FakeElement("div");
  documentStub.body.appendChild(root);
  const api = {
    async listProjects() { return []; },
    async listQuests() { return []; },
    async listProjectAssets() { return []; }
  };
  const app = new StudioApp(root, api);
  app.state.access = Object.freeze({ mode: "local-owner", auth: null, mutationProof: true, members: null, membersError: null });
  app.state.view = "editor";
  app.state.projects = Object.freeze([{ projectId: PROJECT_ID, title: "Флоренция", role: "owner" }]);
  app.state.selectedProjectId = PROJECT_ID;
  app.state.selectedQuestId = QUEST_ID;
  app.state.quests = Object.freeze([{ projectId: PROJECT_ID, questId: QUEST_ID, draftRevision: 1, title: "Ночная смена", entryLocationId: "yard", contentHash: "x".repeat(64) }]);
  app.state.draft = draftFixture();
  app.state.mission = null;
  app.state.missionRevision = 0;
  app.state.boardPositions = new Map();
  app.state.boardView = "list";
  app.state.inspectorTab = "props";
  app.state.editorMenuOpen = true;
  app.state.phase = "idle";
  app.state.message = "Готово.";
  app.render();
  return { app, root };
}

test("живое приложение: разметка несёт подсказки, описания подключены после перерисовки", () => {
  const { root } = bootApp();

  const addLocation = root.querySelector('[data-action="add-block"][data-block-kind="location"]');
  assert.ok(addLocation, "кнопка добавления места есть в разметке");
  assert.equal(addLocation.getAttribute("data-tooltip"), "add-location");

  const wired = root.querySelectorAll("[data-tooltip]");
  assert.ok(wired.length >= 10, `в редакторе несут подсказки ключевые элементы (найдено ${wired.length})`);
  for (const element of wired) {
    const describedBy = element.getAttribute("aria-describedby");
    assert.ok(describedBy, `у элемента ${element.getAttribute("data-tooltip")} нет aria-describedby`);
    const id = describedBy.split(" ").pop();
    const description = documentStub.body.querySelector(`.${TOOLTIP_DESC_CLASS}[id="${id}"]`);
    assert.ok(description, "описание существует в документе");
    assert.equal(description.textContent, TOOLTIP_TEXTS[element.getAttribute("data-tooltip")], "текст описания совпадает со словарём");
  }

  const validate = root.querySelector('[data-action="validate"]');
  assert.equal(validate.getAttribute("data-tooltip"), "validate-mission");
  const tour = root.querySelector('[data-action="start-tour"]');
  assert.equal(tour.getAttribute("data-tooltip"), "tour");
  assert.ok(root.querySelector('summary[data-tooltip="technical-data"]'), "«Технические данные» объяснены");
});

test("живое приложение: фокус на реальной кнопке показывает облачко с полным текстом", () => {
  const { root } = bootApp();
  const validate = root.querySelector('[data-action="validate"]');
  validate.dispatch("focusin", {});

  const bubble = documentStub.body.querySelector(`.${TOOLTIP_BUBBLE_CLASS}`);
  assert.ok(bubble, "облачко создано");
  assert.equal(bubble.getAttribute(TOOLTIP_VISIBLE_ATTR), "true");
  assert.equal(bubble.textContent, TOOLTIP_TEXTS["validate-mission"]);
  assert.equal(bubble.getAttribute("role"), "tooltip");

  root.dispatch("keydown", { key: "Escape" });
  assert.equal(bubble.getAttribute(TOOLTIP_VISIBLE_ATTR), "false", "Escape закрывает облачко в живом приложении");
});
