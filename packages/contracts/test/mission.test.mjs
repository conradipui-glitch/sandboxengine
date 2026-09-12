import test from "node:test";
import assert from "node:assert/strict";
import {
  MISSION_SCHEMA_VERSION,
  missionContentHash,
  validateMissionDraft
} from "../dist/index.js";

function twoBranchMission() {
  return {
    schemaVersion: "1.0",
    projectId: "project",
    questId: "quest",
    contentRevision: 0,
    contentHash: "",
    listing: {
      title: "Пропавший груз на станции",
      slug: "propavshiy-gruz",
      summary: "Найти груз до рассвета.",
      coverAssetId: null,
      period: "1917",
      place: "Станция",
      playerRole: "Кладовщик",
      estimatedMinutes: 20,
      supportedModes: ["choice"]
    },
    story: {
      entrySceneId: "depot",
      scenes: [
        {
          id: "depot",
          title: "Депо",
          text: "Ночь. Груза нет.",
          dialogue: [],
          choices: [
            { id: "c1", label: "Проверить пути", targetSceneId: "tracks", endingId: null, conditions: [], effects: [] },
            { id: "c2", label: "Допросить сторожа", targetSceneId: "watchman", endingId: null, conditions: [], effects: [] }
          ]
        },
        {
          id: "tracks",
          title: "Пути",
          text: "Следы ведут в тупик.",
          dialogue: [],
          choices: [{ id: "c3", label: "Открыть вагон", targetSceneId: null, endingId: "found", conditions: [], effects: [] }]
        },
        {
          id: "watchman",
          title: "Сторожка",
          text: "Сторож молчит.",
          dialogue: [],
          choices: [{ id: "c4", label: "Уйти ни с чем", targetSceneId: null, endingId: "lost", conditions: [], effects: [] }]
        }
      ],
      endings: [
        { id: "found", title: "Груз найден", text: "Ящики на месте." },
        { id: "lost", title: "След потерян", text: "Рассвело." }
      ]
    },
    screens: {
      intros: [],
      scenes: {
        depot: {
          background: null,
          inheritBackground: true,
          layers: [
            {
              id: "layer-1", kind: "actor", name: "Кладовщик", visible: true, locked: false,
              asset: { assetId: "asset-1", hash: "a".repeat(64) },
              x: 0.2, y: 0.5, scale: 1, rotation: 0, flipH: false, flipV: false, opacity: 1, z: 1
            }
          ],
          music: null
        }
      },
      endings: {}
    },
    defaults: { background: null, theme: "station-night", animationPreset: "calm" }
  };
}

test("M01 mission: two-branch draft validates clean", () => {
  assert.equal(MISSION_SCHEMA_VERSION, "1.0");
  assert.deepEqual(validateMissionDraft(twoBranchMission()), []);
});

test("M01 mission: dangling choice target is rejected", () => {
  const doc = twoBranchMission();
  doc.story.scenes[0].choices[0].targetSceneId = "nowhere";
  assert.ok(validateMissionDraft(doc).includes("mission.choice_target_missing"));
});

test("M01 mission: missing entry scene is rejected", () => {
  const doc = twoBranchMission();
  doc.story.entrySceneId = "void";
  assert.ok(validateMissionDraft(doc).includes("mission.entry_missing"));
});

test("M01 mission: unreachable ending is rejected", () => {
  const doc = twoBranchMission();
  doc.story.endings.push({ id: "orphan-end", title: "Лишний", text: "..." });
  assert.ok(validateMissionDraft(doc).includes("mission.ending_unreachable"));
});

test("M01 mission: hash changes on text edit and on layer move", async () => {
  const base = await missionContentHash(twoBranchMission());
  assert.equal(base.length, 64);
  const textEdit = twoBranchMission();
  textEdit.story.scenes[0].text = "Другая ночь.";
  assert.notEqual(await missionContentHash(textEdit), base);
  const layerMove = twoBranchMission();
  layerMove.screens.scenes.depot.layers[0].x = 0.7;
  assert.notEqual(await missionContentHash(layerMove), base);
  assert.equal(await missionContentHash(twoBranchMission()), base);
});

// --- FACT-2: choice.conditions / choice.effects validation ---

function hasError(errors, prefix) {
  return errors.some((error) => error.startsWith(prefix));
}

test("FACT-2: unknown key inside a choice condition is rejected with a field path", () => {
  const doc = twoBranchMission();
  doc.story.scenes[0].choices[0].conditions = [{ nope: 1 }];
  const errors = validateMissionDraft(doc);
  assert.ok(hasError(errors, "mission.choice_condition_invalid"), JSON.stringify(errors));
  assert.ok(
    errors.includes("mission.choice_condition_invalid:depot.c1.conditions[0]"),
    JSON.stringify(errors)
  );
});

test("FACT-2: stale schemaVersion inside a condition is rejected", () => {
  const doc = twoBranchMission();
  doc.story.scenes[0].choices[0].conditions = [
    { schemaVersion: "9.9", type: "resource.atLeast", resourceId: "res", value: 1 }
  ];
  assert.ok(hasError(validateMissionDraft(doc), "mission.choice_condition_invalid"));
});

test("FACT-2: non-integer condition value is rejected", () => {
  const doc = twoBranchMission();
  doc.story.scenes[0].choices[0].conditions = [
    { schemaVersion: "1.0", type: "resource.atLeast", resourceId: "res", value: 1.5 }
  ];
  assert.ok(hasError(validateMissionDraft(doc), "mission.choice_condition_invalid"));
});

test("FACT-2: unknown key inside a choice effect is rejected with a field path", () => {
  const doc = twoBranchMission();
  doc.story.scenes[0].choices[0].effects = [{ junk: 1 }];
  const errors = validateMissionDraft(doc);
  assert.ok(hasError(errors, "mission.choice_effect_invalid"), JSON.stringify(errors));
  assert.ok(
    errors.includes("mission.choice_effect_invalid:depot.c1.effects[0]"),
    JSON.stringify(errors)
  );
});

test("FACT-2: non-integer effect delta is rejected", () => {
  const doc = twoBranchMission();
  doc.story.scenes[0].choices[0].effects = [
    { schemaVersion: "1.0", type: "resource.change", sourceId: "src", resourceId: "res", delta: 1.5 }
  ];
  assert.ok(hasError(validateMissionDraft(doc), "mission.choice_effect_invalid"));
});

test("FACT-2: non-array conditions/effects are rejected", () => {
  const doc = twoBranchMission();
  const choice = doc.story.scenes[0].choices[0];
  choice.conditions = { not: "array" };
  choice.effects = "nope";
  const errors = validateMissionDraft(doc);
  assert.ok(errors.includes("mission.choice_conditions_missing:depot.c1"), JSON.stringify(errors));
  assert.ok(errors.includes("mission.choice_effects_missing:depot.c1"), JSON.stringify(errors));
});

test("FACT-2: well-formed conditions and effects still validate clean", () => {
  const doc = twoBranchMission();
  const choice = doc.story.scenes[0].choices[0];
  choice.conditions = [
    { schemaVersion: "1.0", type: "resource.atLeast", resourceId: "res", value: 5 },
    {
      schemaVersion: "1.0",
      type: "all",
      conditions: [{ schemaVersion: "1.0", type: "entity.at", entityId: "e1", locationId: "depot" }]
    }
  ];
  choice.effects = [
    { schemaVersion: "1.0", type: "resource.change", sourceId: "src", resourceId: "res", delta: -1 },
    { schemaVersion: "1.0", type: "entity.move", sourceId: "src", entityId: "e1", locationId: "depot" }
  ];
  assert.deepEqual(validateMissionDraft(doc), []);
});
