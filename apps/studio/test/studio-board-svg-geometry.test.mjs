import test from "node:test";
import assert from "node:assert/strict";

import { missionToStoryBoard } from "../dist/src/story-model.js";
import { STORY_NODE_H, STORY_NODE_W } from "../dist/src/story-commands.js";

// ---------------------------------------------------------------------------
// Минимальный DOM-шим, как в fin05-story-board.test.mjs: тестируем реальный
// dist-модуль story-dom.js без браузера.
// ---------------------------------------------------------------------------

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.className = "";
    this.textContent = "";
    this.handlers = {};
    this.disabled = false;
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) { this.children.splice(i, 1); child.parentNode = null; } return child; }
  get firstChild() { return this.children[0] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === "class") this.className = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, handler) { (this.handlers[type] ??= []).push(handler); }
  removeEventListener(type, handler) { const list = this.handlers[type]; if (list) { const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1); } }
  dispatch(type, event) { for (const handler of [...(this.handlers[type] ?? [])]) handler(event); }
  remove() { this.parentNode?.removeChild(this); }
  closest(selector) { const cls = selector.replace(/^\./, ""); let node = this; while (node) { if ((node.className || "").split(/\s+/).includes(cls)) return node; node = node.parentNode; } return null; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const results = [];
    const attrMatch = selector.match(/^\[([^=\]]+)(?:="(.*)")?\]$/);
    const walk = (node) => {
      for (const child of node.children) {
        const cls = (child.className || "").split(/\s+/);
        let ok = false;
        if (attrMatch) ok = attrMatch[2] === undefined ? attrMatch[1] in child.attributes : child.attributes[attrMatch[1]] === attrMatch[2];
        else if (selector.startsWith(".")) ok = cls.includes(selector.slice(1));
        else ok = child.tagName.toLowerCase() === selector.toLowerCase();
        if (ok) results.push(child);
        walk(child);
      }
    };
    walk(this);
    return results;
  }
  getBoundingClientRect() { return this._rect ?? { left: 0, top: 0, width: 0, height: 0 }; }
}

function makeDom() {
  return {
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    activeElement: null
  };
}

function makeWindow() {
  const handlers = {};
  return {
    handlers,
    addEventListener(type, handler) { (handlers[type] ??= []).push(handler); },
    removeEventListener(type, handler) { const list = handlers[type]; if (list) { const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1); } },
    dispatch(type, event) { for (const handler of [...(handlers[type] ?? [])]) handler(event); }
  };
}

function mission() {
  return {
    schemaVersion: "1.0",
    projectId: "project",
    questId: "quest",
    contentRevision: 1,
    contentHash: "c".repeat(64),
    listing: {
      title: "Депо", slug: "depo", summary: "", coverAssetId: null, period: "", place: "",
      playerRole: "", estimatedMinutes: 10, supportedModes: ["choice"]
    },
    story: {
      entrySceneId: "depot",
      scenes: [
        {
          id: "depot", title: "Депо", text: "Ночь.", dialogue: [],
          choices: [{ id: "c1", label: "На пути", targetSceneId: "tracks", endingId: null, conditions: [], effects: [] }]
        },
        { id: "tracks", title: "Пути", text: "Тупик.", dialogue: [], choices: [] }
      ],
      endings: []
    },
    screens: { intros: [], scenes: {}, endings: {} },
    defaults: { background: null, theme: "", animationPreset: "" }
  };
}

function parseView() {
  const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/.exec(document.__world.style.transform ?? "");
  assert.ok(m, `world transform parses: ${document.__world.style.transform}`);
  return { panX: Number(m[1]), panY: Number(m[2]), scale: Number(m[3]) };
}

/** Экранная точка, в которую реально попадает SVG-user-координата (ux, uy). */
function svgUserToScreen(svg, view, ux, uy) {
  const [vbx, vby, vbw, vbh] = String(svg.getAttribute("viewBox")).trim().split(/[\s,]+/).map(Number);
  const widthAttr = Number(svg.getAttribute("width"));
  const heightAttr = Number(svg.getAttribute("height"));
  const left = Number(svg.style.left ?? "0") || 0;
  const top = Number(svg.style.top ?? "0") || 0;
  const worldX = left + (ux - vbx) * (widthAttr / vbw);
  const worldY = top + (uy - vby) * (heightAttr / vbh);
  return { x: worldX * view.scale + view.panX, y: worldY * view.scale + view.panY };
}

function expectedScreen(view, worldX, worldY) {
  return { x: worldX * view.scale + view.panX, y: worldY * view.scale + view.panY };
}

function parsePathStart(d) {
  const m = /^M\s+([-\d.]+)[\s,]+([-\d.]+)/.exec(String(d));
  assert.ok(m, `path starts with M x y: ${d}`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

test("Studio board SVG edges use world coordinates exactly once at fit / wheel-zoom / pan", async () => {
  const { mountStoryBoard } = await import("../dist/src/story-dom.js");
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const dom = makeDom();
  const win = makeWindow();
  globalThis.document = dom;
  globalThis.window = win;
  try {
    const container = new FakeElement("div");
    const model = missionToStoryBoard(mission(), new Map());
    const handle = mountStoryBoard(container, { model, editable: true });

    const viewport = container.querySelector(".story-viewport");
    viewport._rect = { left: 0, top: 0, width: 800, height: 600 };
    document.__world = container.querySelector(".story-world");
    // первый repaint с честным размером вьюпорта, но ещё без pan/zoom (scale=1, pan=0)
    handle.update(model, true);

    const svg = container.querySelector(".story-edges");
    const cards = new Map(container.querySelectorAll(".story-node").map((card) => [card.dataset.nodeId, card]));
    const expectedEdge = model.edges.find((edge) => edge.source === "depot" && edge.target === "tracks");
    assert.ok(expectedEdge, "mission board has depot -> tracks edge");
    const edgePath = container.querySelectorAll(".story-edge")
      .find((path) => path.getAttribute("data-edge-id") === expectedEdge.id);
    assert.ok(edgePath, "edge path is rendered");

    const anchor = (nodeId) => {
      const card = cards.get(nodeId);
      assert.ok(card, `card ${nodeId} exists`);
      const left = Number.parseFloat(card.style.left);
      const top = Number.parseFloat(card.style.top);
      return { x: left + STORY_NODE_W, y: top + STORY_NODE_H / 2 };
    };

    const checkAligned = (stage) => {
      const view = parseView();
      // 1) никакого второго масштаба/сдвига в самом SVG: user → world — тождество
      const [vbx, vby, vbw, vbh] = String(svg.getAttribute("viewBox")).trim().split(/[\s,]+/).map(Number);
      assert.equal(vbx, 0, `${stage}: viewBox min-x is not offset (pan applied once, by world)`);
      assert.equal(vby, 0, `${stage}: viewBox min-y is not offset`);
      assert.equal(Number(svg.getAttribute("width")) / vbw, 1, `${stage}: svg x scale is 1:1`);
      assert.equal(Number(svg.getAttribute("height")) / vbh, 1, `${stage}: svg y scale is 1:1`);
      assert.equal(Number(svg.style.left ?? "0") || 0, 0, `${stage}: svg not shifted inside world`);

      // 2) ребро рисуется там же, где карточка-источник (одна система координат)
      const from = anchor("depot");
      const edgeUser = parsePathStart(edgePath.getAttribute("d"));
      const rendered = svgUserToScreen(svg, view, edgeUser.x, edgeUser.y);
      const card = expectedScreen(view, from.x, from.y);
      assert.ok(Math.abs(rendered.x - card.x) < 1e-6, `${stage}: edge x ${rendered.x} == card x ${card.x}`);
      assert.ok(Math.abs(rendered.y - card.y) < 1e-6, `${stage}: edge y ${rendered.y} == card y ${card.y}`);
    };

    // обратный случай: до любых преобразований карточка и ребро уже совпадают
    checkAligned("initial (no transform)");

    handle.fit();
    const fitted = parseView();
    assert.ok(fitted.scale < 1 || fitted.panX !== 0 || fitted.panY !== 0, "fit changed the view");
    checkAligned("after fit()");

    viewport.dispatch("wheel", { deltaY: -1, clientX: 400, clientY: 300, preventDefault() {} });
    const zoomed = parseView();
    assert.ok(zoomed.scale > fitted.scale, "wheel zoomed in");
    checkAligned("after wheel zoom");

    // pan: shift+pointer на пустом месте, затем движение окна
    viewport.dispatch("pointerdown", { button: 0, shiftKey: true, clientX: 100, clientY: 100, target: viewport, preventDefault() {} });
    win.dispatch("pointermove", { clientX: 190, clientY: 130 });
    win.dispatch("pointerup", {});
    const panned = parseView();
    assert.ok(Math.abs(panned.panX - (zoomed.panX + 90)) < 1e-6, "pan moved panX by the drag delta");
    assert.ok(Math.abs(panned.panY - (zoomed.panY + 30)) < 1e-6, "pan moved panY by the drag delta");
    checkAligned("after pan");

    // повторный fit возвращает детерминированный вид — геометрия та же
    handle.fit();
    checkAligned("after re-fit");
    assert.deepEqual(parseView(), fitted, "fit is deterministic");

    handle.destroy();
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});
