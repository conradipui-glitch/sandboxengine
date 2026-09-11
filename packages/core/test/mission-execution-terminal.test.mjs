import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMissionChoice,
  assertMissionTerminal,
  availableMissionChoices,
  MissionTerminalValidationError,
  missionTerminalStatus
} from "../dist/mission-execution.js";

/**
 * Defect (B13 core): mission-execution.ts compared `world.terminal !== null`.
 * A world without the `terminal` key (undefined) satisfied that comparison and
 * the engine declared the story finished: no choices, "mission_ended" on every
 * turn — a silent, unplayable dead end. Contract: only an explicit
 * WorldTerminal object ends the story; an invalid value is a validation error.
 */

function worldBase() {
  return {
    schemaVersion: "1.0",
    revision: 0,
    clock: { elapsedSeconds: 0 },
    locations: [{ id: "depot" }],
    entities: [],
    items: [],
    resources: []
  };
}

/** World with the `terminal` key intentionally absent (author world / legacy snapshot). */
function worldWithoutTerminalKey() {
  return worldBase();
}

function worldWithNullTerminal() {
  return { ...worldBase(), terminal: null };
}

function worldWithTerminal(terminal) {
  return { ...worldBase(), terminal };
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
              effects: []
            }
          ]
        },
        {
          id: "tracks",
          title: "Пути",
          text: "Тупик.",
          dialogue: [],
          choices: [
            { id: "open", label: "Открыть", targetSceneId: null, endingId: "found", conditions: [], effects: [] }
          ]
        }
      ],
      endings: [{ id: "found", title: "Найден", text: "Ящики." }]
    },
    screens: {},
    defaults: {}
  };
}

function stateWith(world, sceneId = "depot", turn = 0) {
  return { currentSceneId: sceneId, world, turn };
}

test("terminal: missing key means the story is still playable", () => {
  const doc = mission();
  const state = stateWith(worldWithoutTerminalKey());
  assert.equal("terminal" in state.world, false);
  assert.deepEqual(missionTerminalStatus(state.world), { kind: "active" });

  const choices = availableMissionChoices(doc, state);
  assert.deepEqual(choices.map((choice) => choice.choiceId), ["go-tracks"]);

  const applied = applyMissionChoice(doc, state, { choiceId: "go-tracks" });
  assert.equal(applied.ok, true);
  assert.equal(applied.state.currentSceneId, "tracks");
  assert.equal(applied.state.turn, 1);
  assert.equal("terminal" in applied.state.world, false, "moving between scenes must not invent a terminal");
});

test("terminal: missing key does not degrade a full playthrough to a dead end", () => {
  const doc = mission();
  const first = applyMissionChoice(doc, stateWith(worldWithoutTerminalKey()), { choiceId: "go-tracks" });
  assert.equal(first.ok, true);
  const list = availableMissionChoices(doc, first.state);
  assert.deepEqual(list.map((choice) => choice.choiceId), ["open"]);

  const end = applyMissionChoice(doc, first.state, { choiceId: "open" });
  assert.equal(end.ok, true);
  assert.deepEqual(end.target, { kind: "ending", endingId: "found" });
  assert.deepEqual(end.state.world.terminal, { reason: "mission.ending", outcome: "found" });

  // Only now, on an explicit terminal object, does the story read as finished.
  assert.deepEqual(availableMissionChoices(doc, end.state), []);
  assert.deepEqual(applyMissionChoice(doc, end.state, { choiceId: "open" }), { ok: false, reason: "mission_ended" });
});

test("terminal: explicit null stays playable (regression guard)", () => {
  const doc = mission();
  const state = stateWith(worldWithNullTerminal());
  assert.deepEqual(missionTerminalStatus(state.world), { kind: "active" });
  assert.deepEqual(availableMissionChoices(doc, state).map((choice) => choice.choiceId), ["go-tracks"]);
  assert.equal(applyMissionChoice(doc, state, { choiceId: "go-tracks" }).ok, true);
});

test("terminal: explicit ended object ends the mission", () => {
  const doc = mission();
  const state = stateWith(worldWithTerminal({ reason: "mission.ending", outcome: "found" }));
  assert.deepEqual(missionTerminalStatus(state.world), {
    kind: "ended",
    terminal: { reason: "mission.ending", outcome: "found" }
  });
  assert.deepEqual(availableMissionChoices(doc, state), []);
  assert.deepEqual(applyMissionChoice(doc, state, { choiceId: "go-tracks" }), { ok: false, reason: "mission_ended" });
});

for (const [label, terminal] of [
  ["string", "boom"],
  ["number", 0],
  ["boolean", false],
  ["array", []],
  ["object without reason/outcome", {}],
  ["empty reason", { reason: "", outcome: "found" }],
  ["non-string outcome", { reason: "mission.ending", outcome: 7 }]
]) {
  test(`terminal: garbage value (${label}) raises a validation error, never a silent dead end`, () => {
    const doc = mission();
    const state = stateWith(worldWithTerminal(terminal));
    const status = missionTerminalStatus(state.world);
    assert.equal(status.kind, "invalid");
    assert.equal(typeof status.error, "string");
    assert.equal(status.error.length > 0, true);

    assert.throws(
      () => availableMissionChoices(doc, state),
      (error) => {
        assert.equal(error instanceof MissionTerminalValidationError, true);
        assert.equal(error.code, "invalid_world_terminal");
        assert.match(error.message, /invalid world terminal/);
        return true;
      }
    );
    assert.throws(
      () => applyMissionChoice(doc, state, { choiceId: "go-tracks" }),
      MissionTerminalValidationError
    );
    assert.throws(() => assertMissionTerminal(state.world), MissionTerminalValidationError);
  });
}
