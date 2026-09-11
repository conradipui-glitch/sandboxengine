// Тест начального показа доски (RED->GREEN): mountBoard обязан открывать доску в
// ЧИТАЕМОМ масштабе — тем же честным вписыванием, что и «Показать всё», но с
// порогом читаемости (minReadableScale = 12/13) и без сжатия автора до 25%
// с нечитаемым текстом карточек. Мини-DOM тот же, что в board-gestures.test.mjs
// (делегированные pointer-события), assertions — по getViewport() handle'а —
// реальный публичный контракт модуля, без внутренностей.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
    const drop = new Set(names);
    this.element.className = [...tokens].filter((t) => !drop.has(t)).join(" ");
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
    this.offsetWidth = 248;
    this.offsetHeight = 112;
    this.clientWidth = 0;
    this.clientHeight = 0;
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
    for (const child of nodes) this.appendChild(child);
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
    if (event && !event.target) event.target = this;
    let node = this;
    while (node) {
      for (const entry of [...(node.listeners.get(event.type) ?? [])]) entry.handler.call(node, event);
      node = node.parentNode;
    }
    return true;
  }
  matches(selector) {
    return String(selector)
      .split(",")
      .some((part) => this.matchesSimple(part.trim()));
  }
  matchesSimple(selector) {
    if (!selector) return false;
    const tokens = String(selector).match(/^[a-zA-Z]+|[.#][\w-]+|\[[^\]]+\]/g) ?? [];
    return tokens.length > 0 && tokens.every((token) => {
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
    return { left: 0, top: 0, right: 960, bottom: 560, width: 960, height: 560 };
  }
  setPointerCapture() {}
  releasePointerCapture() {}
}

const documentStub = {
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_ns, tag) => new FakeElement(tag),
  elementFromPoint: () => null,
  addEventListener() {},
  removeEventListener() {}
};

const rafQueue = [];
globalThis.Element = FakeElement;
globalThis.document = documentStub;
globalThis.window = {
  setTimeout: () => 0,
  clearTimeout: () => {},
  requestAnimationFrame: (callback) => {
    rafQueue.push(callback);
    return rafQueue.length;
  },
  cancelAnimationFrame: () => {}
};

const { mountBoard } = await import("../dist/src/board-dom.js");
const { minReadableScale } = await import("../dist/src/board-viewport.js");
const FIT_TOLERANCE_PX = 8; // допуск на округление pan при почти-точном вписывании

const node = (id, type, x, y) => ({
  id,
  type,
  label: id,
  x,
  y,
  block: { kind: type, id, title: id, description: "", isEntry: false }
});

const baseModel = {
  nodes: [
    node("n1", "character", 0, 0),
    node("n2", "location", 400, 0),
    node("n3", "resource", 800, 0),
    node("n4", "action", 0, 220),
    node("n5", "location", 400, 220)
  ],
  edges: [],
  entryLocationId: "n2"
};

function mountWith(model, { width = 960, height = 560 } = {}) {
  const container = new FakeElement("div");
  // В живом браузере viewport монтируется в реальный host с ненулевой
  // геометрией; фейковый контейнер обязан её воспроизводить, иначе двойной rAF
  // guard (viewport.clientWidth > 0) молча пропустит начальное вписывание —
  // именно так это происходит в живом Studio.
  container.clientWidth = width;
  container.clientHeight = height;
  const handle = mountBoard(container, { model, editable: true });
  // В живом браузере у самого полотна есть ненулевая геометрия (CSS height:
  // 100% растягивает его в хосте). Фейковый viewport обязан её воспроизводить,
  // иначе guard viewport.clientWidth > 0 молча пропустит вписывание.
  const viewportEl = container.children.find((child) => child.className === "board-viewport");
  assert.ok(viewportEl, "mountBoard обязан смонтировать .board-viewport в контейнер");
  viewportEl.clientWidth = width;
  viewportEl.clientHeight = height;
  // Начальное вписывание живёт в двойном rAF после монтирования: прогреваем
  // очередь дважды, чтобы кадры реально выполнились, как в живом браузере.
  const drain = () => {
    const batch = rafQueue.splice(0, rafQueue.length);
    for (const cb of batch) cb();
    return batch.length;
  };
  drain();
  drain();
  return handle;
}

const here = dirname(fileURLToPath(import.meta.url));
const studioDir = join(here, "..");
const boardDomPath = join(studioDir, "src", "board-dom.ts");
const cssBoardPath = join(studioDir, "styles", "board.css");
const cssGraphitePath = join(studioDir, "styles", "theme-graphite.css");
function cssBoard() {
  return readFileSync(cssBoardPath, "utf8");
}
function cssGraphite() {
  return readFileSync(cssGraphitePath, "utf8");
}

test("mount: initial fit never compresses the author below the readability threshold", () => {
  const handle = mountWith(baseModel);
  const viewport = handle.getViewport();
  assert.ok(
    viewport.scale >= minReadableScale(),
    `начальный масштаб ${viewport.scale} ниже порога читаемости (12/13) — автор видит нечитаемый текст`
  );
  assert.ok(
    viewport.scale <= 1,
    `начальное вписывание не должно увеличивать карточки, получено ${viewport.scale}`
  );
  // «Показать всё» остаётся явным overview: кнопка fit может опускаться до 25%.
  handle.fit();
  const fitScale = handle.getViewport().scale;
  assert.ok(
    fitScale <= viewport.scale,
    `явный «Показать всё» — это overview и может опускаться ниже начального вида, получено ${fitScale} против ${viewport.scale}`
  );
  handle.destroy();
});

test("mount: initial fit centers content in the viewport instead of pinning to the top-left corner", () => {
  const handle = mountWith(baseModel);
  const viewport = handle.getViewport();
  // Центрирование с допуском на округление: при вписывании почти точь-в-точь
  // pan может быть на пару пикселей отрицательным — дефектом это не является.
  // Дефект 25% давал pan (0, 0) при контенте, уходящем за полотно на тысячи px.
  assert.ok(
    viewport.panX >= -FIT_TOLERANCE_PX && viewport.panY >= -FIT_TOLERANCE_PX,
    `начальный вид обязан центрировать содержимое (panX ${viewport.panX}, panY ${viewport.panY} — контент прижат к углу, как в дефекте 25%)`
  );
  handle.destroy();
});

test("mount: empty board starts at 100% (identity) — 25% пустого полотна ничего не читает", () => {
  const handle = mountWith({ nodes: [], edges: [], entryLocationId: null });
  const viewport = handle.getViewport();
  assert.equal(viewport.scale, 1, `пустая доска обязана стартовать с 100%, получено ${viewport.scale}`);
  assert.deepEqual([viewport.panX, viewport.panY], [0, 0]);
  handle.destroy();
});

/* ── Геометрия CSS-компаньона: board.css обязан давать полотну фактическую
   высоту хоста. В дефекте .board-viewport жил только с min-height: 320px
   внутри хоста clamp(420px, 100vh - 255px, 680px): полотно занимало 320px,
   а оставшиеся сотни пикселей хоста были мёртвыми. ======================= */

test("css: .board-host .board-viewport fills the host height (geometry, not just min-height)", () => {
  const sheet = cssBoard();
  assert.match(
    sheet,
    /\.board-host \.board-viewport\s*\{[^}]*height:\s*100%/,
    ".board-host .board-viewport обязан иметь height: 100% — иначе полотно занимает только min-height 320px внутри высокого хоста, а низ хоста мёртв"
  );
  // min-height 320px ОСТАЁТСЯ как страховка от нулевой высоты (пол, а не потолок):
  // дефект создавало отсутствие height, а не наличие пола.
  void sheet;
});

test("css: .board-world grid size (4000x4000) stays in sync with board-dom WORLD_SIZE", () => {
  const sheet = cssBoard();
  const dom = readFileSync(boardDomPath, "utf8");
  const worldSize = Number(/const WORLD_SIZE = (\d+);/.exec(dom)?.[1]);
  assert.equal(worldSize, 4000, "board-dom.ts: WORLD_SIZE");
  assert.match(
    sheet,
    new RegExp(`\\.board-host \\.board-world\\s*\\{[^}]*width:\\s*${worldSize}px`),
    "board.css: .board-world width обязан совпадать с WORLD_SIZE"
  );
  assert.match(
    sheet,
    new RegExp(`\\.board-host \\.board-world\\s*\\{[^}]*height:\\s*${worldSize}px`),
    "board.css: .board-world height обязан совпадать с WORLD_SIZE"
  );
});

test("css: .board-node keeps an opaque surface and never clips its ports", () => {
  const sheet = cssBoard();
  assert.match(
    sheet,
    /\.board-host \.board-node\s*\{[^}]*background:\s*var\(--surface,\s*#[0-9a-fA-F]+\)/,
    ".board-host .board-node обязан иметь непрозрачную подложку var(--surface) с фолбэком"
  );
  assert.doesNotMatch(
    sheet,
    /\.board-host \.board-node[^{]*\{[^}]*overflow:\s*hidden/,
    ".board-host .board-node не должен обрезать порты (overflow: hidden запрещён)"
  );
});

test("css: graphite theme keeps a single board grid on the viewport, not on the host", () => {
  const sheet = cssGraphite();
  const rule = /\.board-grid,\s*\.board-host\s*\{([^}]*)\}/.exec(sheet);
  assert.ok(rule, "theme-graphite.css обязан содержать правило .board-grid, .board-host");
  const selector = ".board-grid,\n.board-host"; // оба класса держат сетку в дефекте
  assert.doesNotMatch(
    rule[1],
    /background-color|background-image/,
    "правило .board-grid, .board-host не должно само держать сетку хоста (переехало на viewport)"
  );
  assert.match(
    rule[1],
    /background-size/,
    "после переноса сетки на viewport правило хоста обязано держать хотя бы размер сетки"
  );
  const viewportRule = /\.board-host \.board-viewport\s*\{([^}]*)\}/.exec(sheet);
  assert.ok(viewportRule, "theme-graphite.css обязан нацелиться на .board-host .board-viewport");
  assert.match(
    viewportRule[1],
    /background-image/,
    "сетка доски обязана жить на .board-host .board-viewport"
  );
  void selector;
});
