import test from "node:test";
import assert from "node:assert/strict";
import {
  PRESENTATION_SCHEMA_VERSION,
  hasValidPresentationPlanV2References,
  hasValidPresentationTransitionV2,
  hasValidSceneFrameV2References,
  presentationPlanConvergesToTargetFrameV2
} from "../dist/index.js";

const BG = "1".repeat(64);
const ALT = "2".repeat(64);
const ACTOR = "3".repeat(64);
const ITEM = "4".repeat(64);
const MUSIC = "5".repeat(64);

const catalog = Object.freeze({
  sceneIds: Object.freeze(["workshop"]),
  actorEntityIds: Object.freeze(["messenger"]),
  speakerIds: Object.freeze(["messenger"]),
  overlayIds: Object.freeze(["letter-info"]),
  assets: Object.freeze([
    image("workshop-day", BG, "Мастерская"),
    image("alternate-background", ALT, "Другой разрешённый фон"),
    image("messenger", ACTOR, "Гонец"),
    image("letter", ITEM, "Письмо"),
    audio("theme", MUSIC)
  ])
});

const fromFrame = freeze({
  schemaVersion: PRESENTATION_SCHEMA_VERSION,
  frameId: "frame-0",
  sceneId: "workshop",
  sessionId: "session-1",
  questId: "quest-1",
  releaseId: "release-1",
  revision: 0,
  turnId: null,
  background: ref("workshop-day", BG),
  layerOrder: [{ kind: "actor", id: "actor-messenger" }],
  actors: [{ id: "actor-messenger", entityId: "messenger", asset: ref("messenger", ACTOR), slot: "left", expression: "neutral" }],
  items: [],
  overlays: [],
  dialogue: [],
  activeDialogueLineId: null,
  music: null
});

const targetFrame = freeze({
  schemaVersion: PRESENTATION_SCHEMA_VERSION,
  frameId: "frame-1",
  sceneId: "workshop",
  sessionId: "session-1",
  questId: "quest-1",
  releaseId: "release-1",
  revision: 1,
  turnId: "turn-1",
  background: ref("workshop-day", BG),
  layerOrder: [
    { kind: "actor", id: "actor-messenger" },
    { kind: "item", id: "letter-visual" },
    { kind: "overlay", id: "letter-info" }
  ],
  actors: [{ id: "actor-messenger", entityId: "messenger", asset: ref("messenger", ACTOR), slot: "right", expression: "serious" }],
  items: [{ id: "letter-visual", asset: ref("letter", ITEM), slot: "center" }],
  overlays: [{ id: "letter-info", kind: "info", title: "Письмо", body: "Печать гильдии." }],
  dialogue: [{ id: "line-1", speakerId: "messenger", text: "Письмо для мастерской." }],
  activeDialogueLineId: "line-1",
  music: { id: "music-main", asset: ref("theme", MUSIC), loop: true }
});

const validPlan = freeze({
  schemaVersion: PRESENTATION_SCHEMA_VERSION,
  id: "plan-1",
  turnId: "turn-1",
  targetFrameId: "frame-1",
  fromRevision: 0,
  toRevision: 1,
  root: {
    type: "sequence",
    children: [
      { type: "background.set", asset: ref("workshop-day", BG), transition: "crossfade", durationMs: 100 },
      {
        type: "parallel",
        children: [
          { type: "actor.move", actorId: "actor-messenger", slot: "right", transition: "slide", durationMs: 200 },
          { type: "actor.expression", actorId: "actor-messenger", expression: "serious", transition: "crossfade", durationMs: 100 },
          { type: "item.show", asset: ref("letter", ITEM), slot: "center", transition: "fade", durationMs: 100 }
        ]
      },
      { type: "overlay.open", overlayId: "letter-info", transition: "fade", durationMs: 100 },
      { type: "dialogue.show", lineId: "line-1", reveal: "typewriter" },
      { type: "audio.play", asset: ref("theme", MUSIC), channel: "music", loop: true }
    ]
  }
});

test("B07-01 full transition gate proves a valid plan converges to its target SceneFrame", () => {
  assert.equal(hasValidSceneFrameV2References(fromFrame, catalog), true);
  assert.equal(hasValidSceneFrameV2References(targetFrame, catalog), true);
  assert.equal(hasValidPresentationPlanV2References(fromFrame, targetFrame, validPlan, catalog), true);
  assert.equal(presentationPlanConvergesToTargetFrameV2(fromFrame, targetFrame, validPlan), true);
  assert.equal(hasValidPresentationTransitionV2(fromFrame, targetFrame, validPlan, catalog), true);
});

test("allowed references are insufficient: a plan ending on another allowed background is rejected", () => {
  const divergent = clone(validPlan);
  divergent.root.children[0].asset = ref("alternate-background", ALT);
  assert.equal(hasValidPresentationPlanV2References(fromFrame, targetFrame, divergent, catalog), true);
  assert.equal(presentationPlanConvergesToTargetFrameV2(fromFrame, targetFrame, divergent), false);
  assert.equal(hasValidPresentationTransitionV2(fromFrame, targetFrame, divergent, catalog), false);
});

test("allowed actor command with wrong final slot is rejected even though the actor reference is valid", () => {
  const divergent = clone(validPlan);
  divergent.root.children[1].children[0].slot = "left";
  assert.equal(hasValidPresentationPlanV2References(fromFrame, targetFrame, divergent, catalog), true);
  assert.equal(hasValidPresentationTransitionV2(fromFrame, targetFrame, divergent, catalog), false);
});

test("parallel branches may share the same write but conflicting writes have no accidental array-order meaning", () => {
  const sameWrite = clone(validPlan);
  sameWrite.root.children[1].children.push({
    type: "actor.move",
    actorId: "actor-messenger",
    slot: "right",
    transition: "slide",
    durationMs: 50
  });
  assert.equal(hasValidPresentationTransitionV2(fromFrame, targetFrame, sameWrite, catalog), true);

  const conflict = clone(validPlan);
  conflict.root.children[1].children.push({
    type: "actor.move",
    actorId: "actor-messenger",
    slot: "center",
    transition: "slide",
    durationMs: 50
  });
  assert.equal(hasValidPresentationPlanV2References(fromFrame, targetFrame, conflict, catalog), true);
  assert.equal(presentationPlanConvergesToTargetFrameV2(fromFrame, targetFrame, conflict), false);
  assert.equal(hasValidPresentationTransitionV2(fromFrame, targetFrame, conflict, catalog), false);
});

test("transition identity is bound to one session/release/turn/target frame", () => {
  const otherRelease = clone(targetFrame);
  otherRelease.releaseId = "release-2";
  assert.equal(hasValidPresentationTransitionV2(fromFrame, otherRelease, validPlan, catalog), false);

  const wrongTarget = { ...validPlan, targetFrameId: "frame-other" };
  assert.equal(hasValidPresentationTransitionV2(fromFrame, targetFrame, wrongTarget, catalog), false);

  const missingTurn = { ...targetFrame, turnId: null };
  assert.equal(hasValidSceneFrameV2References(missingTurn, catalog), false, "committed revision must have a persisted turnId");
});

function image(id, hash, altText) {
  return freeze({
    schemaVersion: PRESENTATION_SCHEMA_VERSION,
    id,
    hash,
    kind: "image",
    mimeType: "image/webp",
    widthPx: 1920,
    heightPx: 1080,
    durationMs: null,
    altText,
    source: "fixture",
    rights: "test-only"
  });
}

function audio(id, hash) {
  return freeze({
    schemaVersion: PRESENTATION_SCHEMA_VERSION,
    id,
    hash,
    kind: "audio",
    mimeType: "audio/ogg",
    widthPx: null,
    heightPx: null,
    durationMs: 30_000,
    altText: null,
    source: "fixture",
    rights: "test-only"
  });
}

function ref(assetId, hash) {
  return { assetId, hash };
}

function clone(value) {
  return structuredClone(value);
}

function freeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
