import test from "node:test";
import assert from "node:assert/strict";
import {
  addStoryChoice,
  addStoryEnding,
  addStoryScene,
  missionToStoryBoard,
  removeStoryChoice,
  removeStoryNode,
  storyFallbackPosition,
  storyPositionKey,
  updateStoryNode,
  storyRendererPositions
} from "../dist/src/story-model.js";

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
          id: "depot", title: "Депо", text: "Ночь.", dialogue: [],
          choices: [
            { id: "c1", label: "На пути", targetSceneId: "tracks", endingId: null, conditions: [], effects: [] },
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

test("M05 story board: scenes and endings become nodes, choices become labeled edges", () => {
  const model = missionToStoryBoard(mission(), new Map());
  assert.deepEqual(model.nodes.map((node) => node.id).sort(), ["depot", "found", "lost", "tracks"]);
  const depot = model.nodes.find((node) => node.id === "depot");
  assert.equal(depot.type, "scene");
  assert.equal(depot.isEntry, true);
  assert.equal(model.nodes.find((node) => node.id === "found").type, "ending");
  assert.deepEqual(
    model.edges.map((edge) => [edge.source, edge.target, edge.label]),
    [["depot", "tracks", "На пути"], ["depot", "lost", "Финал сразу"], ["tracks", "found", "Открыть"]]
  );
  assert.equal(model.entrySceneId, "depot");
});

test("M05 story board: saved positions win, fallback is deterministic per kind", () => {
  const a = storyFallbackPosition("scene", 0);
  const b = storyFallbackPosition("scene", 0);
  const ending = storyFallbackPosition("ending", 0);
  assert.deepEqual(a, b);
  assert.ok(ending.x !== a.x || ending.y !== a.y);
  const model = missionToStoryBoard(mission(), new Map([["depot", { x: 11, y: 22 }]]));
  assert.deepEqual([model.positions.get("depot"), typeof model.positions.get("tracks")], [{ x: 11, y: 22 }, "object"]);
});

test("M05 story board: dangling choice targets never become edges", () => {
  const doc = mission();
  doc.story.scenes[0].choices.push({ id: "cx", label: "В никуда", targetSceneId: "void", endingId: null, conditions: [], effects: [] });
  const model = missionToStoryBoard(doc, new Map());
  assert.equal(model.edges.some((edge) => edge.target === "void"), false);
  assert.equal(model.edges.length, 3);
});

test("M05 story mutations: add scene/ending/choice, duplicate ids rejected", () => {
  const first = addStoryScene(mission(), { id: "s3", title: "Тупик" });
  assert.equal(first.ok, true);
  assert.equal(first.story.scenes.length, 3);
  const dup = addStoryScene(mission(), { id: "depot", title: "Дубль" });
  assert.deepEqual([dup.ok, dup.error], [false, "story.id_taken"]);
  const cross = addStoryEnding(mission(), { id: "depot", title: "Дубль" });
  assert.deepEqual([cross.ok, cross.error], [false, "story.id_taken"]);
  const ending = addStoryEnding(mission(), { id: "e3", title: "Новый финал" });
  assert.equal(ending.ok, true);
  assert.equal(ending.story.endings.length, 3);
  const choice = addStoryChoice(mission(), {
    sceneId: "tracks", choiceId: "c9", label: "Назад",
    targetSceneId: "depot", endingId: null
  });
  assert.equal(choice.ok, true);
  assert.equal(choice.story.scenes[1].choices.length, 2);
  const both = addStoryChoice(mission(), {
    sceneId: "tracks", choiceId: "cx", label: "Обе цели",
    targetSceneId: "depot", endingId: "found"
  });
  assert.deepEqual([both.ok, both.error], [false, "story.choice_target_missing"]);
});

test("M05 story mutations: remove node is fail-closed on entry and references", () => {
  assert.deepEqual(removeStoryNode(mission(), "depot").error, "story.entry_protected");
  assert.deepEqual(removeStoryNode(mission(), "tracks").error, "story.node_referenced");
  assert.deepEqual(removeStoryNode(mission(), "found").error, "story.node_referenced");
  assert.deepEqual(removeStoryNode(mission(), "void").error, "story.node_missing");
  const orphan = mission();
  orphan.story.scenes[0].choices = orphan.story.scenes[0].choices.filter((choice) => choice.targetSceneId !== "tracks");
  orphan.story.scenes[1].choices = [];
  const removed = removeStoryNode(orphan, "tracks");
  assert.equal(removed.ok, true);
  assert.equal(removed.story.scenes.length, 1);
  const choiceRemoved = removeStoryChoice(mission(), "depot", "c1");
  assert.equal(choiceRemoved.ok, true);
  assert.equal(choiceRemoved.story.scenes[0].choices.length, 1);
  assert.deepEqual(removeStoryChoice(mission(), "depot", "void").error, "story.choice_missing");
});

test("M05 story positions: story: prefix avoids block collisions", () => {
  assert.equal(storyPositionKey("depot"), "story:depot");
  const renderer = storyRendererPositions(new Map([["story:depot", { x: 1, y: 2 }], ["block-1", { x: 9, y: 9 }]]));
  assert.deepEqual([...renderer.entries()], [["depot", { x: 1, y: 2 }]]);
});

test("M05 story mutations: update node title/text, missing rejected", () => {
  const updated = updateStoryNode(mission(), { nodeId: "depot", title: "Депо ", text: "Новый текст" });
  assert.equal(updated.ok, true);
  assert.equal(updated.story.scenes[0].title, "Депо");
  assert.equal(updated.story.scenes[0].text, "Новый текст");
  const ending = updateStoryNode(mission(), { nodeId: "found", title: "Финал", text: "Конец" });
  assert.equal(ending.ok, true);
  assert.equal(ending.story.endings[0].title, "Финал");
  assert.deepEqual(updateStoryNode(mission(), { nodeId: "void", title: "x", text: "" }).error, "story.node_missing");
  assert.deepEqual(updateStoryNode(mission(), { nodeId: "depot", title: "  ", text: "" }).error, "story.id_or_title_empty");
});
