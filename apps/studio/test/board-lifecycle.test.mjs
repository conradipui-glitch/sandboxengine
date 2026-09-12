import test from "node:test";
import assert from "node:assert/strict";

import { BoardLifecycle } from "../dist/src/board-lifecycle.js";

function model(id = "node-1") {
  return {
    nodes: [{ id, type: "location", label: id, x: 0, y: 0, block: { kind: "location", id, title: id, description: "", isEntry: true } }],
    edges: [],
    entryLocationId: id,
    positions: new Map([[id, { x: 0, y: 0 }]])
  };
}

function fakeRendererFactory() {
  const mounts = [];
  const factory = {
    mount(_container, options) {
      const callbacks = options;
      const handle = {
        models: [options.model],
        selections: [],
        editable: options.editable,
        viewport: { scale: 1, panX: 0, panY: 0 },
        destroyed: false,
        update(next) { this.models.push(next); },
        updateSelection(id) { this.selections.push(id); },
        setEditable(value) { this.editable = value; },
        getViewport() { return { ...this.viewport }; },
        setViewport(next) { this.viewport = { ...next }; },
        fit() { this.viewport = { scale: 0.5, panX: 12, panY: 18 }; },
        destroy() { this.destroyed = true; }
      };
      mounts.push({ callbacks, handle });
      return handle;
    }
  };
  return { factory, mounts };
}

test("K01 lifecycle mounts once, updates model/selection without remounting, and preserves viewport", () => {
  const { factory, mounts } = fakeRendererFactory();
  const lifecycle = new BoardLifecycle(factory);
  const container = {};
  lifecycle.mount({
    projectId: "p1",
    questId: "q1",
    container,
    model: model(),
    editable: true,
    selectedNodeId: "node-1"
  });

  assert.equal(mounts.length, 1);
  lifecycle.setViewport("p1", "q1", { scale: 1.75, panX: -24, panY: 36 });
  lifecycle.update("p1", "q1", model("node-2"), "node-2", false);

  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].handle.models.length, 2);
  assert.deepEqual(mounts[0].handle.selections, ["node-1", "node-2"]);
  assert.equal(mounts[0].handle.editable, false);
  assert.deepEqual(lifecycle.getViewport("p1", "q1"), { scale: 1.75, panX: -24, panY: 36 });
});

test("K01 lifecycle invalidates callbacks from the previous quest and destroys exactly once", () => {
  const { factory, mounts } = fakeRendererFactory();
  const lifecycle = new BoardLifecycle(factory);
  const calls = [];
  lifecycle.mount({
    projectId: "p1",
    questId: "q1",
    container: {},
    model: model(),
    editable: true,
    onSelect: (id) => calls.push(`old:${id}`)
  });
  const oldCallbacks = mounts[0].callbacks;

  lifecycle.mount({
    projectId: "p1",
    questId: "q2",
    container: {},
    model: model("node-q2"),
    editable: true,
    onSelect: (id) => calls.push(`new:${id}`)
  });
  oldCallbacks.onSelect("node-1");
  mounts[1].callbacks.onSelect("node-q2");

  assert.deepEqual(calls, ["new:node-q2"]);
  assert.equal(mounts[0].handle.destroyed, true);
  assert.equal(mounts[1].handle.destroyed, false);

  lifecycle.destroy();
  lifecycle.destroy();
  assert.equal(mounts[1].handle.destroyed, true);
});
