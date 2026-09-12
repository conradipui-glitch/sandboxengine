import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMissionChoice,
  availableMissionChoices,
  sidecarBeatsToMissionStory
} from "../dist/mission-execution.js";

function world() {
  return {
    schemaVersion: "1.0",
    revision: 0,
    clock: { elapsedSeconds: 0 },
    locations: [{ id: "depot" }],
    entities: [],
    items: [],
    resources: [{ id: "lanterns", unit: "шт", value: 2, min: 0, max: 5 }],
    terminal: null
  };
}

function mission() {
  return {
    schemaVersion: "1.0",
    projectId: "project",
    questId: "quest",
    contentRevision: 1,
    contentHash: "x",
    listing: {},
    story: {
      entrySceneId: "depot",
      scenes: [
        {
          id: "depot",
          title: "Депо",
          text: "Ночь.",
          dialogue: [],
          choices: [
            {
              id: "go-tracks",
              label: "На пути",
              targetSceneId: "tracks",
              endingId: null,
              conditions: [],
              effects: [{ schemaVersion: "1.0", type: "resource.change", sourceId: "go-tracks", resourceId: "lanterns", delta: -1 }]
            },
            {
              id: "bribe",
              label: "Подкупить",
              targetSceneId: "watchman",
              endingId: null,
              conditions: [{ type: "resource.atLeast", resourceId: "lanterns", value: 5 }],
              effects: []
            }
          ]
        },
        {
          id: "tracks",
          title: "Пути",
          text: "Тупик.",
          dialogue: [],
          choices: [{ id: "open", label: "Открыть", targetSceneId: null, endingId: "found", conditions: [], effects: [] }]
        },
        {
          id: "watchman",
          title: "Сторожка",
          text: "Молчание.",
          dialogue: [],
          choices: [{ id: "leave", label: "Уйти", targetSceneId: null, endingId: "lost", conditions: [], effects: [] }]
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

function stateAt(sceneId) {
  return { currentSceneId: sceneId, world: world(), turn: 0 };
}

test("M02 mission execution: fork A and B reach different scenes", () => {
  const doc = mission();
  const viaA = applyMissionChoice(doc, stateAt("depot"), { choiceId: "go-tracks" });
  assert.equal(viaA.ok, true);
  assert.deepEqual(viaA.target, { kind: "scene", sceneId: "tracks" });
  assert.equal(viaA.state.currentSceneId, "tracks");
  assert.equal(viaA.state.turn, 1);
  assert.equal(viaA.state.world.resources[0].value, 1);

  const viaB = applyMissionChoice(doc, stateAt("depot"), { choiceId: "bribe" });
  assert.equal(viaB.ok, false);
  assert.equal(viaB.reason, "choice_blocked");
});

test("M02 mission execution: endings terminate, turn is not a scene index", () => {
  const doc = mission();
  const end = applyMissionChoice(doc, stateAt("tracks"), { choiceId: "open" });
  assert.equal(end.ok, true);
  assert.deepEqual(end.target, { kind: "ending", endingId: "found" });
  assert.equal(end.state.turn, 1);
  const after = applyMissionChoice(doc, end.state, { choiceId: "open" });
  assert.equal(after.ok, false);
});

test("M02 mission execution: wrong-scene choice is rejected, replay is deterministic", () => {
  const doc = mission();
  const wrong = applyMissionChoice(doc, stateAt("tracks"), { choiceId: "go-tracks" });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, "choice_not_in_scene");
  const first = applyMissionChoice(doc, stateAt("depot"), { choiceId: "go-tracks" });
  const second = applyMissionChoice(doc, stateAt("depot"), { choiceId: "go-tracks" });
  assert.deepEqual(first, second);
});

test("M02 mission execution: available choices report condition status", () => {
  const list = availableMissionChoices(mission(), stateAt("depot"));
  assert.deepEqual(list.map((entry) => entry.status), ["available", "blocked"]);
});

test("M02 mission execution: legacy sidecar beats become a linear mission story", () => {
  const story = sidecarBeatsToMissionStory({
    beats: [
      { id: "b1", title: "Раз", options: [{ id: "o1", status: "executed", effects: [] }] },
      { id: "b2", title: "Два", options: [] }
    ]
  });
  assert.equal(story.entrySceneId, "b1");
  assert.equal(story.scenes.length, 2);
  assert.equal(story.scenes[0].choices[0].targetSceneId, "b2");
  assert.equal(story.endings.length, 1);
});
