import test from "node:test";
import assert from "node:assert/strict";
import { PresentationExecutor } from "../dist/index.js";

const baseFrame = freeze({
  schemaVersion: "2.0",
  frameId: "frame-0",
  sceneId: "scene",
  sessionId: "session",
  questId: "quest",
  releaseId: "release",
  revision: 0,
  turnId: null,
  background: null,
  layerOrder: [],
  actors: [],
  items: [],
  overlays: [],
  dialogue: [],
  activeDialogueLineId: null,
  music: null
});

const frame1 = freeze({ ...baseFrame, frameId: "frame-1", revision: 1, turnId: "turn-1" });
const frame2 = freeze({ ...baseFrame, frameId: "frame-2", revision: 2, turnId: "turn-2" });

const waitPlan = freeze({
  schemaVersion: "2.0",
  id: "wait-plan",
  turnId: "turn-1",
  targetFrameId: "frame-1",
  fromRevision: 0,
  toRevision: 1,
  root: { type: "wait", durationMs: 1 }
});

test("a slow old restore cannot overwrite a newer confirmed frame", async () => {
  const renderer = new BlockingFrameRenderer();
  const executor = new PresentationExecutor(renderer);
  await executor.restore(baseFrame);

  renderer.blockFrameId = "frame-1";
  const oldRestore = executor.restore(frame1);
  await renderer.blockStarted;

  const newer = await executor.restore(frame2);
  const old = await oldRestore;

  assert.equal(newer.currentFrame.frameId, "frame-2");
  assert.equal(old.reason, "superseded");
  assert.equal(executor.snapshot.currentFrame.frameId, "frame-2");
  assert.equal(executor.snapshot.lastConsumedTurnId, "turn-2");
  assert.equal(executor.snapshot.status, "idle");
});

test("cancelActive leaves the last confirmed frame intact and executor idle", async () => {
  const renderer = new BlockingFrameRenderer();
  const executor = new PresentationExecutor(renderer);
  await executor.restore(baseFrame);

  renderer.blockFrameId = "frame-1";
  renderer.resetBlockSignal();
  const oldRestore = executor.restore(frame1);
  await renderer.blockStarted;
  executor.cancelActive();
  const result = await oldRestore;

  assert.equal(result.reason, "superseded");
  assert.equal(executor.snapshot.currentFrame.frameId, "frame-0");
  assert.equal(executor.snapshot.status, "idle");
});

test("runtime plan objects cannot widen the canonical per-command duration bound", async () => {
  const renderer = new BlockingFrameRenderer();
  const executor = new PresentationExecutor(renderer);
  await executor.restore(baseFrame);
  renderer.events.length = 0;

  const tooLong = clone(waitPlan);
  tooLong.root.durationMs = 60_001;
  const result = await executor.present({ targetFrame: frame1, plan: tooLong });

  assert.equal(result.outcome, "recovered");
  assert.equal(result.reason, "invalid_or_non_convergent_plan");
  assert.deepEqual(renderer.events, ["frame:frame-1"]);
  assert.equal(renderer.events.some((event) => event.startsWith("wait:")), false);
});

class BlockingFrameRenderer {
  events = [];
  blockFrameId = null;
  #blockResolve;
  blockStarted = new Promise((resolve) => { this.#blockResolve = resolve; });

  resetBlockSignal() {
    this.blockStarted = new Promise((resolve) => { this.#blockResolve = resolve; });
  }

  async applyFrame(frame, signal) {
    this.events.push(`frame:${frame.frameId}`);
    if (frame.frameId !== this.blockFrameId) return;
    this.#blockResolve?.();
    await waitForAbort(signal);
  }
  async setBackground() {}
  async showActor() {}
  async hideActor() {}
  async moveActor() {}
  async setActorExpression() {}
  async showItem() {}
  async showDialogue() {}
  async openOverlay() {}
  async closeOverlay() {}
  async playAudio() {}
  async stopAudio() {}
  async wait(durationMs) { this.events.push(`wait:${durationMs}`); }
}

function waitForAbort(signal) {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function freeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
