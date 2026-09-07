import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import {
  CONTRACT_SCHEMA_IDS,
  PRESENTATION_MAX_DURATION_MS,
  PRESENTATION_SCHEMA_VERSION,
  classifyPresentationDelivery,
  classifySceneFrameUpdate,
  hasValidAssetManifestV2,
  hasValidPresentationPlanV2References,
  hasValidSceneFrameV2References,
  measurePresentationTree
} from "../dist/index.js";

const HASH_BG = "1".repeat(64);
const HASH_ACTOR = "2".repeat(64);
const HASH_ITEM = "3".repeat(64);
const HASH_MUSIC = "4".repeat(64);
const HASH_EFFECT = "5".repeat(64);

const assets = Object.freeze([
  imageAsset("workshop-day", HASH_BG, "Мастерская днём"),
  imageAsset("messenger-portrait", HASH_ACTOR, "Гонец"),
  imageAsset("sealed-letter", HASH_ITEM, "Запечатанное письмо"),
  audioAsset("workshop-theme", HASH_MUSIC, 30_000),
  audioAsset("paper-rustle", HASH_EFFECT, 800)
]);

const catalog = Object.freeze({
  sceneIds: Object.freeze(["workshop"]),
  actorEntityIds: Object.freeze(["messenger"]),
  speakerIds: Object.freeze(["messenger"]),
  overlayIds: Object.freeze(["letter-info"]),
  assets
});

const fromFrame = deepFreeze({
  schemaVersion: PRESENTATION_SCHEMA_VERSION,
  frameId: "frame-0",
  sceneId: "workshop",
  sessionId: "session-1",
  questId: "quest-1",
  releaseId: "release-1",
  revision: 0,
  turnId: null,
  background: assetRef("workshop-day", HASH_BG),
  layerOrder: [{ kind: "actor", id: "actor-messenger" }],
  actors: [{
    id: "actor-messenger",
    entityId: "messenger",
    asset: assetRef("messenger-portrait", HASH_ACTOR),
    slot: "offscreen-left",
    expression: "neutral"
  }],
  items: [],
  overlays: [],
  dialogue: [],
  activeDialogueLineId: null,
  music: null
});

const targetFrame = deepFreeze({
  schemaVersion: PRESENTATION_SCHEMA_VERSION,
  frameId: "frame-1",
  sceneId: "workshop",
  sessionId: "session-1",
  questId: "quest-1",
  releaseId: "release-1",
  revision: 1,
  turnId: "turn-1",
  background: assetRef("workshop-day", HASH_BG),
  layerOrder: [
    { kind: "actor", id: "actor-messenger" },
    { kind: "item", id: "letter-visual" },
    { kind: "overlay", id: "letter-info" }
  ],
  actors: [{
    id: "actor-messenger",
    entityId: "messenger",
    asset: assetRef("messenger-portrait", HASH_ACTOR),
    slot: "left",
    expression: "serious"
  }],
  items: [{
    id: "letter-visual",
    asset: assetRef("sealed-letter", HASH_ITEM),
    slot: "center"
  }],
  overlays: [{
    id: "letter-info",
    kind: "info",
    title: "Письмо",
    body: "На печати знак гильдии."
  }],
  dialogue: [{
    id: "arrival-line",
    speakerId: "messenger",
    text: "Письмо для мастерской."
  }],
  activeDialogueLineId: "arrival-line",
  music: {
    id: "music-main",
    asset: assetRef("workshop-theme", HASH_MUSIC),
    loop: true
  }
});

const validPlan = deepFreeze({
  schemaVersion: PRESENTATION_SCHEMA_VERSION,
  id: "messenger-arrival",
  turnId: "turn-1",
  targetFrameId: "frame-1",
  fromRevision: 0,
  toRevision: 1,
  root: {
    type: "sequence",
    children: [
      {
        type: "background.set",
        asset: assetRef("workshop-day", HASH_BG),
        transition: "crossfade",
        durationMs: 250
      },
      {
        type: "parallel",
        children: [
          { type: "actor.show", actorId: "actor-messenger", slot: "left", transition: "slide", durationMs: 350 },
          { type: "actor.move", actorId: "actor-messenger", slot: "left", transition: "slide", durationMs: 350 },
          { type: "actor.expression", actorId: "actor-messenger", expression: "serious", transition: "crossfade", durationMs: 180 },
          { type: "item.show", asset: assetRef("sealed-letter", HASH_ITEM), slot: "center", transition: "fade", durationMs: 250 }
        ]
      },
      { type: "overlay.open", overlayId: "letter-info", transition: "fade", durationMs: 150 },
      { type: "dialogue.show", lineId: "arrival-line", reveal: "typewriter" },
      { type: "audio.play", asset: assetRef("paper-rustle", HASH_EFFECT), channel: "effect", loop: false },
      { type: "audio.play", asset: assetRef("workshop-theme", HASH_MUSIC), channel: "music", loop: true },
      { type: "wait", durationMs: 200 },
      { type: "audio.stop", channel: "effect" },
      { type: "overlay.close", overlayId: "letter-info", transition: "fade", durationMs: 100 },
      { type: "actor.hide", actorId: "actor-messenger", transition: "fade", durationMs: 100 },
      { type: "actor.show", actorId: "actor-messenger", slot: "left", transition: "fade", durationMs: 100 }
    ]
  }
});

async function loadValidator(relative, id) {
  const schema = JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(schema);
  const validator = ajv.getSchema(id);
  assert.ok(validator, `schema not registered: ${id}`);
  return validator;
}

test("B07-01 presentation v2 has separate stable schema IDs and leaves legacy v1 untouched", async () => {
  assert.equal(PRESENTATION_SCHEMA_VERSION, "2.0");
  assert.equal(CONTRACT_SCHEMA_IDS.sceneFrame, "urn:living-history:schema:scene-frame:1.0");
  assert.equal(CONTRACT_SCHEMA_IDS.presentationPlan, "urn:living-history:schema:presentation-plan:1.0");
  assert.equal(CONTRACT_SCHEMA_IDS.assetManifestV2, "urn:living-history:schema:asset-manifest:2.0");
  assert.equal(CONTRACT_SCHEMA_IDS.sceneFrameV2, "urn:living-history:schema:scene-frame:2.0");
  assert.equal(CONTRACT_SCHEMA_IDS.presentationPlanV2, "urn:living-history:schema:presentation-plan:2.0");

  const legacyFrame = JSON.parse(await readFile(new URL("../fixtures/scene-frame.valid.json", import.meta.url), "utf8"));
  assert.equal(legacyFrame.schemaVersion, "1.0");
});

test("AssetManifestV2 is immutable-hash typed and distinguishes image/audio semantics", async () => {
  const validate = await loadValidator("../schemas/v2/asset-manifest.schema.json", CONTRACT_SCHEMA_IDS.assetManifestV2);
  for (const asset of assets) {
    assert.equal(validate(asset), true, JSON.stringify(validate.errors));
    assert.equal(hasValidAssetManifestV2(asset), true);
  }

  const noAlt = { ...assets[0], altText: null };
  assert.equal(validate(noAlt), false, "visual asset requires text alternative");
  assert.equal(hasValidAssetManifestV2(noAlt), false);

  const audioWithWidth = { ...assets[3], widthPx: 100 };
  assert.equal(validate(audioWithWidth), false);
  assert.equal(hasValidAssetManifestV2(audioWithWidth), false);
});

test("SceneFrameV2 schema + semantic catalog validation prove complete reload-safe final state", async () => {
  const validate = await loadValidator("../schemas/v2/scene-frame.schema.json", CONTRACT_SCHEMA_IDS.sceneFrameV2);
  assert.equal(validate(fromFrame), true, JSON.stringify(validate.errors));
  assert.equal(validate(targetFrame), true, JSON.stringify(validate.errors));
  assert.equal(hasValidSceneFrameV2References(fromFrame, catalog), true);
  assert.equal(hasValidSceneFrameV2References(targetFrame, catalog), true);

  const wrongHash = clone(targetFrame);
  wrongHash.background.hash = "9".repeat(64);
  assert.equal(validate(wrongHash), true, "hash mismatch is cross-object semantics, not JSON shape");
  assert.equal(hasValidSceneFrameV2References(wrongHash, catalog), false);

  const duplicateLayer = clone(targetFrame);
  duplicateLayer.layerOrder[2] = { ...duplicateLayer.layerOrder[1] };
  assert.equal(validate(duplicateLayer), true);
  assert.equal(hasValidSceneFrameV2References(duplicateLayer, catalog), false);

  const hiddenSpeaker = clone(targetFrame);
  hiddenSpeaker.dialogue[0].speakerId = "secret-npc";
  assert.equal(validate(hiddenSpeaker), true);
  assert.equal(hasValidSceneFrameV2References(hiddenSpeaker, catalog), false);
});

test("PresentationPlanV2 accepts bounded sequence/parallel commands and rejects executable authority", async () => {
  const validate = await loadValidator("../schemas/v2/presentation-plan.schema.json", CONTRACT_SCHEMA_IDS.presentationPlanV2);
  assert.equal(validate(validPlan), true, JSON.stringify(validate.errors));
  assert.equal(hasValidPresentationPlanV2References(fromFrame, targetFrame, validPlan, catalog), true);
  assert.deepEqual(measurePresentationTree(validPlan.root), { nodeCount: 16, maxDepth: 3 });

  const withCss = clone(validPlan);
  withCss.root.children[1].children[0].style = "position:fixed;inset:0";
  assert.equal(validate(withCss), false, "arbitrary CSS/extra authority must fail closed");

  const withScript = clone(validPlan);
  withScript.root.children[0].script = "commitGameplay()";
  assert.equal(validate(withScript), false, "script callbacks are not presentation commands");

  const unknownCommand = clone(validPlan);
  unknownCommand.root.children[0] = { type: "dom.query", selector: "#app" };
  assert.equal(validate(unknownCommand), false);
});

test("PresentationPlanV2 semantic validation rejects unknown refs, wrong revision and asset hash", async () => {
  const validate = await loadValidator("../schemas/v2/presentation-plan.schema.json", CONTRACT_SCHEMA_IDS.presentationPlanV2);

  const badActor = clone(validPlan);
  badActor.root.children[1].children[0].actorId = "secret-actor";
  assert.equal(validate(badActor), true);
  assert.equal(hasValidPresentationPlanV2References(fromFrame, targetFrame, badActor, catalog), false);

  const badLine = clone(validPlan);
  badLine.root.children[3].lineId = "hidden-line";
  assert.equal(validate(badLine), true);
  assert.equal(hasValidPresentationPlanV2References(fromFrame, targetFrame, badLine, catalog), false);

  const badOverlay = clone(validPlan);
  badOverlay.root.children[2].overlayId = "admin-panel";
  assert.equal(validate(badOverlay), true);
  assert.equal(hasValidPresentationPlanV2References(fromFrame, targetFrame, badOverlay, catalog), false);

  const badHash = clone(validPlan);
  badHash.root.children[1].children[3].asset.hash = "8".repeat(64);
  assert.equal(validate(badHash), true);
  assert.equal(hasValidPresentationPlanV2References(fromFrame, targetFrame, badHash, catalog), false);

  const skippedRevision = { ...validPlan, toRevision: 2 };
  assert.equal(validate(skippedRevision), true);
  assert.equal(hasValidPresentationPlanV2References(fromFrame, targetFrame, skippedRevision, catalog), false);
});

test("tree/deadline-like presentation bounds prevent unbounded animation programs", async () => {
  const validate = await loadValidator("../schemas/v2/presentation-plan.schema.json", CONTRACT_SCHEMA_IDS.presentationPlanV2);

  let deep = { type: "wait", durationMs: 0 };
  for (let index = 0; index < 8; index += 1) deep = { type: "sequence", children: [deep] };
  const deepPlan = { ...validPlan, root: deep };
  assert.equal(validate(deepPlan), true, "JSON recursion is shape-valid; semantic depth bound is separate");
  assert.equal(measurePresentationTree(deepPlan.root), null);
  assert.equal(hasValidPresentationPlanV2References(fromFrame, targetFrame, deepPlan, catalog), false);

  const tooMany = {
    type: "sequence",
    children: Array.from({ length: 5 }, () => ({
      type: "parallel",
      children: Array.from({ length: 64 }, () => ({ type: "wait", durationMs: 0 }))
    }))
  };
  assert.equal(measurePresentationTree(tooMany), null);

  const longWait = clone(validPlan);
  longWait.root.children[6].durationMs = PRESENTATION_MAX_DURATION_MS + 1;
  assert.equal(validate(longWait), false);
  assert.equal(hasValidPresentationPlanV2References(fromFrame, targetFrame, longWait, catalog), false);
});

test("reload/replay helpers refuse downgrade and do not replay a committed turn", () => {
  assert.equal(classifySceneFrameUpdate(null, fromFrame), "advance");
  assert.equal(classifySceneFrameUpdate(fromFrame, fromFrame), "duplicate");
  assert.equal(classifySceneFrameUpdate(targetFrame, fromFrame), "stale");
  assert.equal(classifySceneFrameUpdate(fromFrame, { ...fromFrame, frameId: "other-frame" }), "conflict");
  assert.equal(classifySceneFrameUpdate(fromFrame, targetFrame), "advance");

  assert.equal(classifyPresentationDelivery(fromFrame, null, validPlan), "play");
  assert.equal(classifyPresentationDelivery(fromFrame, "turn-1", validPlan), "duplicate");
  assert.equal(classifyPresentationDelivery(targetFrame, null, validPlan), "duplicate");

  const unchanged = JSON.stringify(targetFrame);
  classifyPresentationDelivery(targetFrame, "turn-1", validPlan);
  assert.equal(JSON.stringify(targetFrame), unchanged, "delivery decisions are pure and cannot mutate final frame/gameplay");
});

test("presentation public structures contain no gameplay mutation or executable keys", () => {
  const keys = collectKeys({ targetFrame, validPlan });
  for (const forbidden of [
    "statePatch", "effects", "resourceDelta", "durationSeconds", "gameplayCallback",
    "script", "selector", "style", "html", "onComplete", "commitTurn", "worldState"
  ]) {
    assert.equal(keys.has(forbidden), false, `presentation contract must not expose ${forbidden}`);
  }
});

function imageAsset(id, hash, altText) {
  return deepFreeze({
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

function audioAsset(id, hash, durationMs) {
  return deepFreeze({
    schemaVersion: PRESENTATION_SCHEMA_VERSION,
    id,
    hash,
    kind: "audio",
    mimeType: "audio/ogg",
    widthPx: null,
    heightPx: null,
    durationMs,
    altText: null,
    source: "fixture",
    rights: "test-only"
  });
}

function assetRef(assetId, hash) {
  return { assetId, hash };
}

function clone(value) {
  return structuredClone(value);
}

function collectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys);
    return keys;
  }
  if (value === null || typeof value !== "object") return keys;
  for (const [key, entry] of Object.entries(value)) {
    keys.add(key);
    collectKeys(entry, keys);
  }
  return keys;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
