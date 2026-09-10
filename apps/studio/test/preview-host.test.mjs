import test from "node:test";
import assert from "node:assert/strict";
import {
  MISSION_RENDERER_VERSION,
  PREVIEW_BRIDGE_VERSION,
  buildHostFrame,
  createPreviewNonce,
  validateHostInbound
} from "../dist/src/preview-bridge.js";
import { PreviewHost } from "../dist/src/preview-host.js";

test("M04 preview bridge: versions are pinned and frames fail closed", () => {
  assert.equal(PREVIEW_BRIDGE_VERSION, 1);
  assert.equal(MISSION_RENDERER_VERSION, "1.0.0");
  const nonce = createPreviewNonce((count) => new Uint8Array(count).fill(7));
  assert.equal(nonce.length, 24);
  const frame = { rendererVersion: "1.0.0", title: "t" };
  const built = buildHostFrame(nonce, "screen", frame);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.message.mode, "screen");
  const wrongRenderer = buildHostFrame(nonce, "screen", { rendererVersion: "9.9.9" });
  assert.deepEqual(wrongRenderer, { ok: false, code: "BRIDGE_RENDERER_VERSION" });
  const bad = validateHostInbound("https://studio.test", "https://studio.test", nonce, {
    protocol: "lhc-mission-preview",
    version: PREVIEW_BRIDGE_VERSION,
    type: "eval",
    nonce,
    payload: "alert(1)"
  });
  assert.deepEqual(bad, { ok: false, code: "BRIDGE_TYPE" });
  const foreign = validateHostInbound("https://evil.test", "https://studio.test", nonce, {
    protocol: "lhc-mission-preview",
    version: PREVIEW_BRIDGE_VERSION,
    type: "ready",
    nonce
  });
  assert.deepEqual(foreign, { ok: false, code: "BRIDGE_ORIGIN" });
});

test("M04 preview host: mount/ready/post/destroy lifecycle with stale guards", () => {
  const posted = [];
  const listeners = new Set();
  const removed = [];
  const dom = {
    createIframe: () => ({
      contentWindow: { postMessage: (message, targetOrigin) => posted.push({ message, targetOrigin }) },
      remove: () => removed.push(true)
    }),
    addMessageListener: (listener) => { listeners.add(listener); },
    removeMessageListener: (listener) => { listeners.delete(listener); },
    randomValues: (count) => new Uint8Array(count).fill(3)
  };
  const events = [];
  const host = new PreviewHost(dom, "https://studio.test", "https://studio.test/preview", {
    onReady: () => events.push("ready"),
    onSelection: (selection) => events.push(`select:${selection.layerId}`),
    onRejected: (code) => events.push(`reject:${code}`)
  });
  const nonce = host.mount();
  assert.equal(typeof nonce, "string");
  assert.equal(host.postFrame("screen", { rendererVersion: "1.0.0" }), false);
  for (const listener of listeners) {
    listener({
      origin: "https://studio.test",
      data: { protocol: "lhc-mission-preview", version: 1, type: "ready", nonce }
    });
  }
  assert.deepEqual(events, ["ready"]);
  assert.equal(host.postFrame("screen", { rendererVersion: "1.0.0", title: "t" }), true);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].targetOrigin, "https://studio.test");
  for (const listener of listeners) {
    listener({
      origin: "https://studio.test",
      data: {
        protocol: "lhc-mission-preview", version: 1, type: "selection", nonce,
        payload: { layerId: "actor-1" }
      }
    });
  }
  assert.deepEqual(events, ["ready", "select:actor-1"]);
  host.destroy();
  assert.equal(removed.length, 1);
  assert.equal(host.postFrame("screen", { rendererVersion: "1.0.0" }), false);
  for (const listener of [...listeners]) {
    listener({
      origin: "https://studio.test",
      data: { protocol: "lhc-mission-preview", version: 1, type: "ready", nonce }
    });
  }
  assert.deepEqual(events, ["ready", "select:actor-1"]);
});
