import test from "node:test";
import assert from "node:assert/strict";

// ── Мини-DOM: доска работает на делегированных pointer-событиях, поэтому
// проверяем маршрутизацию жестов без браузера (поведенческий тест, не снимок).
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
    return String(selector)
      .split(",")
      .some((part) => this.matchesSimple(part.trim()));
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
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_ns, tag) => new FakeElement(tag),
  elementFromPoint: () => null,
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

const node = (id, type, x, y) => ({
  id,
  type,
  label: id,
  x,
  y,
  block: { kind: type, id, title: id, description: "", isEntry: type === "location" }
});

const model = {
  nodes: [node("n1", "character", 0, 0), node("n2", "location", 400, 0)],
  edges: [],
  entryLocationId: "n2"
};

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

function mount(options = {}) {
  const host = new FakeElement("div");
  const events = { moved: [], selected: [], connected: [] };
  const board = mountBoard(host, {
    model,
    editable: options.editable ?? true,
    onMove: (id, x, y) => events.moved.push({ id, x, y }),
    onSelect: (id) => events.selected.push(id),
    onConnect: (source, target) => events.connected.push({ source, target })
  });
  const cards = host.querySelectorAll(".board-node");
  return { host, board, events, cards, card: (id) => cards.find((item) => item.dataset.nodeId === id) };
}

test("UX: карточка тянется за тело, а не только за шапку", () => {
  const { card, events } = mount();
  const body = card("n1").querySelector(".node-body");
  body.dispatchEvent(pointer("pointerdown", { x: 10, y: 10 }));
  card("n1").dispatchEvent(pointer("pointermove", { x: 90, y: 50 }));
  card("n1").dispatchEvent(pointer("pointerup", { x: 90, y: 50 }));

  assert.equal(events.connected.length, 0, "перетаскивание тела не должно создавать связь");
  assert.ok(events.moved.length > 0, "onMove не вызван: тело карточки не работает ручкой");
  const last = events.moved.at(-1);
  assert.equal(last.id, "n1");
  assert.ok(last.x > 0 && last.y > 0, `карточка не сдвинулась: ${JSON.stringify(last)}`);
});

test("UX: карточка тянется за шапку (регресс-страховка)", () => {
  const { card, events } = mount();
  const head = card("n1").querySelector(".node-head");
  head.dispatchEvent(pointer("pointerdown", { x: 10, y: 10 }));
  card("n1").dispatchEvent(pointer("pointermove", { x: 60, y: 30 }));
  card("n1").dispatchEvent(pointer("pointerup", { x: 60, y: 30 }));

  assert.ok(events.moved.length > 0, "шапка перестала тянуть карточку");
});

test("UX: связь создаётся только от точки соединения (порта)", () => {
  const { card, events } = mount();
  const port = card("n1").querySelectorAll("[data-connect-handle]").find((item) => item.dataset.portDirection === "out");
  assert.ok(port, "у карточки нет исходящего порта");
  port.dispatchEvent(pointer("pointerdown", { x: 246, y: 56 }));
  documentStub.elementFromPoint = () => card("n2");
  card("n1").dispatchEvent(pointer("pointermove", { x: 420, y: 60 }));
  card("n1").dispatchEvent(pointer("pointerup", { x: 420, y: 60 }));

  assert.deepEqual(events.connected, [{ source: "n1", target: "n2" }]);
  assert.equal(events.moved.length, 0, "создание связи не должно двигать карточку");
  documentStub.elementFromPoint = () => null;
});

test("UX: у карточки есть порты с четырёх сторон — выход и вход", () => {
  const { card } = mount();
  const ports = card("n1").querySelectorAll("[data-connect-handle]");
  const sidesOf = (direction) =>
    ports.filter((item) => item.dataset.portDirection === direction).map((item) => item.dataset.portSide).sort();

  assert.deepEqual(sidesOf("out"), ["bottom", "right"]);
  assert.deepEqual(sidesOf("in"), ["left", "top"]);
});

test("UX: клик по телу карточки без движения выбирает её и не создаёт связь", () => {
  const { card, events } = mount();
  const body = card("n1").querySelector(".node-body");
  body.dispatchEvent(pointer("pointerdown", { x: 10, y: 10 }));
  card("n1").dispatchEvent(pointer("pointerup", { x: 10, y: 10 }));

  assert.deepEqual(events.selected, ["n1"]);
  assert.equal(events.connected.length, 0);
  assert.equal(events.moved.length, 0);
});
