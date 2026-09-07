import test from "node:test";
import assert from "node:assert/strict";
import {
  PresentationExecutor
} from "../dist/index.js";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);
const H4 = "4".repeat(64);

const ref = (assetId, hash) => Object.freeze({ assetId, hash });

const fromFrame = freeze({
  schemaVersion: "2.0",
  frameId: "frame-0",
  sceneId: "workshop",
  sessionId: "session-1",
  questId: "quest-1",
  releaseId: "release-1",
  revision: 0,
  turnId: null,
  background: ref("bg-day", H1),
  layerOrder: [{ kind: "actor", id: "actor-messenger" }],
  actors: [{
    id: "actor-messenger",
    entityId: "messenger",
    asset: ref("messenger", H2),
    slot: "left",
    expression: "neutral"
  }],
  items: [],
  overlays: [],
  dialogue: [{ id: "old-line", speakerId: "messenger", text: "Старый текст." }],
  activeDialogueLineId: null,
  music: null
});

const targetFrame = freeze({
  schemaVersion: "2.0",
  frameId: "frame-1",
  sceneId: "workshop",
  sessionId: "session-1",
  questId: "quest-1",
  releaseId: "release-1",
  revision: 1,
  turnId: "turn-1",
  background: ref("bg-night", H3),
  layerOrder: [
    { kind: "actor", id: "actor-messenger" },
    { kind: "item", id: "letter" },
    { kind: "overlay", id: "letter-info" }
  ],
  actors: [{
    id: "actor-messenger",
    entityId: "messenger",
    asset: ref("messenger", H2),
    slot: "right",
    expression: "serious"
  }],
  items: [{ id: "letter", asset: ref("letter", H4), slot: "center" }],
  overlays: [{ id: "letter-info", kind: "info", title: "Письмо", body: "Печать гильдии." }],
  dialogue: [
    { id: "old-line", speakerId: "messenger", text: "Старый текст." },
    { id: "new-line", speakerId: "messenger", text: "Письмо для мастерской." }
  ],
  activeDialogueLineId: "new-line",
  music: { id: "music-main", asset: ref("theme", H4), loop: true }
});

const plan = freeze({
  schemaVersion: "2.0",
  id: "plan-1",
  turnId: "turn-1",
  targetFrameId: "frame-1",
  fromRevision: 0,
  toRevision: 1,
  root: {
    type: "sequence",
    children: [
      { type: "background.set", asset: ref("bg-night", H3), transition: "crossfade", durationMs: 100 },
      {
        type: "parallel",
        children: [
          { type: "actor.move", actorId: "actor-messenger", slot: "right", transition: "slide", durationMs: 200 },
          { type: "actor.expression", actorId: "actor-messenger", expression: "serious", transition: "crossfade", durationMs: 100 },
          { type: "item.show", asset: ref("letter", H4), slot: "center", transition: "fade", durationMs: 100 }
        ]
      },
      { type: "overlay.open", overlayId: "letter-info", transition: "fade", durationMs: 100 },
      { type: "dialogue.show", lineId: "new-line", reveal: "typewriter" },
      { type: "audio.play", asset: ref("theme", H4), channel: "music", loop: true }
    ]
  }
});

test("sequence order, parallel start semantics and final authoritative frame are deterministic", async () => {
  const renderer = new FakeRenderer();
  const executor = new PresentationExecutor(renderer);
  await executor.restore(fromFrame);
  renderer.events.length = 0;

  const result = await executor.present({ targetFrame, plan });
  assert.equal(result.outcome, "played");
  assert.equal(result.currentFrame.frameId, "frame-1");
  assert.equal(result.lastConsumedTurnId, "turn-1");
  assert.deepEqual(renderer.events, [
    "background:bg-night",
    "move:actor-messenger:right",
    "expression:actor-messenger:serious",
    "item:letter:center",
    "overlay.open:letter-info",
    "dialogue:new-line:typewriter",
    "audio.play:music:theme:true",
    "frame:frame-1"
  ]);
  assert.equal(result.currentFrame.dialogue.length, 2, "confirmed frame preserves durable dialogue history");
});

test("parallel siblings start before the group waits for all of them", async () => {
  const renderer = new FakeRenderer();
  const gates = [];
  renderer.parallelGate = (label) => new Promise((resolve) => gates.push({ label, resolve }));
  const executor = new PresentationExecutor(renderer);
  await executor.restore(fromFrame);
  renderer.events.length = 0;

  const running = executor.present({ targetFrame, plan });
  await tick();
  assert.deepEqual(renderer.events.slice(0, 4), [
    "background:bg-night",
    "move:actor-messenger:right",
    "expression:actor-messenger:serious",
    "item:letter:center"
  ]);
  assert.equal(gates.length, 3, "all three parallel leaves start without accidental serialization");
  for (const gate of gates) gate.resolve();
  const result = await running;
  assert.equal(result.outcome, "played");
});

test("skip/reduced-motion before playback execute no plan commands and restore exact target", async () => {
  for (const preferences of [{ skipAnimations: true }, { reducedMotion: true }]) {
    const renderer = new FakeRenderer();
    const executor = new PresentationExecutor(renderer);
    await executor.restore(fromFrame);
    renderer.events.length = 0;
    const result = await executor.present({ targetFrame, plan, preferences });
    assert.equal(result.outcome, "skipped");
    assert.deepEqual(renderer.events, ["frame:frame-1"]);
    assert.equal(result.currentFrame.frameId, targetFrame.frameId);
  }
});

test("skip during a blocking presentation wait cancels remaining effects and restores target", async () => {
  const renderer = new FakeRenderer();
  renderer.blockMoveUntilAbort = true;
  const executor = new PresentationExecutor(renderer);
  await executor.restore(fromFrame);
  renderer.events.length = 0;

  const running = executor.present({ targetFrame, plan });
  await renderer.moveStarted;
  executor.skipActive();
  const result = await running;
  assert.equal(result.outcome, "skipped");
  assert.equal(result.reason, "skip_during_playback");
  assert.equal(renderer.events.includes("overlay.open:letter-info"), false, "later sequence commands are never delivered after skip");
  assert.equal(renderer.events.at(-1), "frame:frame-1");
  assert.equal(result.currentFrame.frameId, "frame-1");
});

test("duplicate/reload/stale/conflict/gap never replay or invent presentation transitions", async () => {
  const renderer = new FakeRenderer();
  const executor = new PresentationExecutor(renderer);
  await executor.restore(fromFrame);
  await executor.present({ targetFrame, plan });
  renderer.events.length = 0;

  const duplicate = await executor.present({ targetFrame, plan });
  assert.equal(duplicate.outcome, "duplicate");
  assert.deepEqual(renderer.events, []);

  const stale = await executor.present({ targetFrame: fromFrame, plan: null });
  assert.equal(stale.outcome, "stale");
  assert.deepEqual(renderer.events, []);

  const conflicting = { ...targetFrame, frameId: "frame-conflict" };
  const conflict = await executor.present({ targetFrame: conflicting, plan: null });
  assert.equal(conflict.outcome, "conflict");
  assert.deepEqual(renderer.events, []);

  const reloadedRenderer = new FakeRenderer();
  const reloaded = new PresentationExecutor(reloadedRenderer);
  await reloaded.restore(targetFrame);
  reloadedRenderer.events.length = 0;
  const afterReload = await reloaded.present({ targetFrame, plan });
  assert.equal(afterReload.outcome, "duplicate");
  assert.deepEqual(reloadedRenderer.events, []);

  const gapTarget = { ...targetFrame, frameId: "frame-3", revision: 3, turnId: "turn-3" };
  const fresh = new PresentationExecutor(reloadedRenderer);
  await fresh.restore(fromFrame);
  reloadedRenderer.events.length = 0;
  const gap = await fresh.present({ targetFrame: gapTarget, plan: null });
  assert.equal(gap.outcome, "recovered");
  assert.equal(gap.reason, "revision_gap");
  assert.deepEqual(reloadedRenderer.events, ["frame:frame-3"]);
});

test("invalid/non-convergent plan is preflight rejected without partial renderer delivery", async () => {
  const renderer = new FakeRenderer();
  const executor = new PresentationExecutor(renderer);
  await executor.restore(fromFrame);
  renderer.events.length = 0;

  const divergent = clone(plan);
  divergent.root.children[0].asset = ref("bg-day", H1);
  const result = await executor.present({ targetFrame, plan: divergent });
  assert.equal(result.outcome, "recovered");
  assert.equal(result.reason, "invalid_or_non_convergent_plan");
  assert.deepEqual(renderer.events, ["frame:frame-1"]);
});

test("media/renderer failure degrades to direct frame restore and consumes the committed turn once", async () => {
  const renderer = new FakeRenderer();
  renderer.failAudio = true;
  const executor = new PresentationExecutor(renderer);
  await executor.restore(fromFrame);
  renderer.events.length = 0;

  const failed = await executor.present({ targetFrame, plan });
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.currentFrame.frameId, "frame-1");
  assert.equal(failed.lastConsumedTurnId, "turn-1");
  assert.equal(renderer.events.at(-1), "frame:frame-1");

  renderer.events.length = 0;
  const retry = await executor.present({ targetFrame, plan });
  assert.equal(retry.outcome, "duplicate");
  assert.deepEqual(renderer.events, [], "presentation failure cannot create an endless replay loop");
});

test("revealTextInstantly changes only presentation reveal policy", async () => {
  const renderer = new FakeRenderer();
  const executor = new PresentationExecutor(renderer);
  await executor.restore(fromFrame);
  renderer.events.length = 0;
  const result = await executor.present({ targetFrame, plan, preferences: { revealTextInstantly: true } });
  assert.equal(result.outcome, "played");
  assert.equal(renderer.events.includes("dialogue:new-line:instant"), true);
  assert.equal(result.currentFrame.dialogue[0].id, "old-line");
  assert.equal(result.currentFrame.dialogue[1].id, "new-line");
});

class FakeRenderer {
  events = [];
  failAudio = false;
  blockMoveUntilAbort = false;
  parallelGate = null;
  #moveResolve;
  moveStarted = new Promise((resolve) => { this.#moveResolve = resolve; });

  async applyFrame(frame) { this.events.push(`frame:${frame.frameId}`); }
  async setBackground(asset) { this.events.push(`background:${asset?.assetId ?? "none"}`); }
  async showActor(actorId, slot) { this.events.push(`show:${actorId}:${slot}`); }
  async hideActor(actorId) { this.events.push(`hide:${actorId}`); }
  async moveActor(actorId, slot, _transition, _durationMs, signal) {
    this.events.push(`move:${actorId}:${slot}`);
    this.#moveResolve?.();
    if (this.parallelGate) await this.parallelGate(`move:${actorId}`);
    if (this.blockMoveUntilAbort) await waitForAbort(signal);
  }
  async setActorExpression(actorId, expression) {
    this.events.push(`expression:${actorId}:${expression}`);
    if (this.parallelGate) await this.parallelGate(`expression:${actorId}`);
  }
  async showItem(asset, slot) {
    this.events.push(`item:${asset.assetId}:${slot}`);
    if (this.parallelGate) await this.parallelGate(`item:${asset.assetId}`);
  }
  async showDialogue(lineId, reveal) { this.events.push(`dialogue:${lineId}:${reveal}`); }
  async openOverlay(overlayId) { this.events.push(`overlay.open:${overlayId}`); }
  async closeOverlay(overlayId) { this.events.push(`overlay.close:${overlayId}`); }
  async playAudio(asset, channel, loop) {
    this.events.push(`audio.play:${channel}:${asset.assetId}:${loop}`);
    if (this.failAudio) throw new Error("media_decode_failed");
  }
  async stopAudio(channel) { this.events.push(`audio.stop:${channel}`); }
  async wait(durationMs, signal) {
    this.events.push(`wait:${durationMs}`);
    if (signal.aborted) throw new Error("aborted");
  }
}

function waitForAbort(signal) {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function freeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
