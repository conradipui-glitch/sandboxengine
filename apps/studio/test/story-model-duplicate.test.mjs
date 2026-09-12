import test from "node:test";
import assert from "node:assert/strict";
import { duplicateStoryScene, duplicateStoryChoice } from "../dist/src/story-model.js";

const CONDITION = Object.freeze({
  schemaVersion: "1.0",
  type: "entity.at",
  entityId: "player",
  locationId: "depot"
});

const EFFECT = Object.freeze({
  schemaVersion: "1.0",
  type: "resource.change",
  sourceId: "quest",
  resourceId: "trust",
  delta: 1
});

function mission() {
  return {
    schemaVersion: "1.0",
    projectId: "project",
    questId: "quest",
    contentRevision: 1,
    contentHash: "c".repeat(64),
    listing: {},
    story: {
      entrySceneId: "depot",
      scenes: [
        {
          id: "depot", title: "Депо", text: "Ночь.",
          dialogue: [{ id: "depot-l1", speakerId: null, text: "Тишина." }],
          choices: [
            {
              id: "c1", label: "На пути", targetSceneId: "depot", endingId: null,
              conditions: [{ ...CONDITION }],
              effects: [{ ...EFFECT }]
            },
            { id: "c2", label: "Финал сразу", targetSceneId: null, endingId: "lost", conditions: [], effects: [] }
          ]
        },
        {
          id: "tracks", title: "Пути", text: "Тупик.", dialogue: [],
          choices: [{ id: "c3", label: "Открыть", targetSceneId: null, endingId: "found", conditions: [], effects: [] }]
        }
      ],
      endings: [
        { id: "found", title: "Найден", text: "Ящики." },
        { id: "lost", title: "Потерян", text: "Рассвело." }
      ]
    },
    screens: {},
    defaults: {}
  };
}

test("R-32 duplicate scene: preserves non-empty conditions/effects as a deep copy", () => {
  const doc = mission();
  const result = duplicateStoryScene(doc, "depot", "depot-copy");
  assert.equal(result.ok, true);

  const copy = result.story.scenes.find((scene) => scene.id === "depot-copy");
  assert.ok(copy, "scene copy exists");
  assert.equal(copy.choices.length, 2);

  const source = doc.story.scenes[0].choices[0];
  const copied = copy.choices.find((choice) => choice.targetSceneId === "depot-copy");
  assert.ok(copied, "self-loop choice rebound to the copy");

  // Author payload carried over verbatim.
  assert.deepEqual(copied.conditions, source.conditions);
  assert.deepEqual(copied.effects, source.effects);
  assert.equal(copied.conditions.length > 0, true);
  assert.equal(copied.effects.length > 0, true);

  // Deep copy: no shared references with the source document (arrays or items).
  assert.notEqual(copied.conditions, source.conditions);
  assert.notEqual(copied.effects, source.effects);
  assert.notEqual(copied.conditions[0], source.conditions[0]);
  assert.notEqual(copied.effects[0], source.effects[0]);

  // Mutating the result must not bleed back into the input document.
  copied.conditions[0].value = 999;
  copied.effects[0].delta = 999;
  assert.equal(doc.story.scenes[0].choices[0].conditions[0].value, undefined);
  assert.equal(doc.story.scenes[0].choices[0].effects[0].delta, 1);
});

test("R-32 duplicate choice: preserves non-empty conditions/effects as a deep copy", () => {
  const doc = mission();
  const result = duplicateStoryChoice(doc, "depot", "c1", "c9");
  assert.equal(result.ok, true);

  const scene = result.story.scenes.find((entry) => entry.id === "depot");
  const copied = scene.choices.find((choice) => choice.id === "c9");
  const source = doc.story.scenes[0].choices[0];
  assert.ok(copied, "duplicated choice exists");

  assert.deepEqual(copied.conditions, source.conditions);
  assert.deepEqual(copied.effects, source.effects);
  assert.equal(copied.conditions.length > 0, true);
  assert.equal(copied.effects.length > 0, true);

  assert.notEqual(copied.conditions, source.conditions);
  assert.notEqual(copied.effects, source.effects);
  assert.notEqual(copied.conditions[0], source.conditions[0]);
  assert.notEqual(copied.effects[0], source.effects[0]);

  copied.effects[0].delta = 999;
  assert.equal(doc.story.scenes[0].choices[0].effects[0].delta, 1);
  assert.equal(source.effects[0].delta, 1);
});

test("R-32 duplicate: empty payloads stay empty and old docs without arrays do not throw", () => {
  const doc = mission();
  const legacy = mission();
  delete legacy.story.scenes[0].choices[0].conditions;
  delete legacy.story.scenes[0].choices[0].effects;
  const sceneResult = duplicateStoryScene(legacy, "depot", "depot-copy");
  assert.equal(sceneResult.ok, true);
  const copiedScene = sceneResult.story.scenes.find((scene) => scene.id === "depot-copy");
  assert.deepEqual(copiedScene.choices.find((choice) => choice.targetSceneId === "depot-copy").conditions, []);
  assert.deepEqual(copiedScene.choices.find((choice) => choice.targetSceneId === "depot-copy").effects, []);

  const choiceResult = duplicateStoryChoice(doc, "depot", "c2", "c10");
  const empty = choiceResult.story.scenes[0].choices.find((choice) => choice.id === "c10");
  assert.deepEqual(empty.conditions, []);
  assert.deepEqual(empty.effects, []);
});
